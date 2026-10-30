import { AudioManager } from '../audio/audio';
import type { LockstepSession } from '../net';
import type { CommandLog, ReplayFile } from '../net/replay';
import type { NetSession } from '../net/session';
import { GameRenderer } from '../render/renderer';
import type { Turn } from '../shared/commands';
import { assignSpawns } from '../shared/maps';
import type { SimEvent } from '../shared/events';
import type { MatchSetup, PlayerId, Tick } from '../shared/types';
import { TICK_MS } from '../shared/types';
import { Simulation } from '../sim/simulation';
import { displaySetup, isLocalMode, type MatchMode, type MatchUi, type ReplayControls, type UiApp } from '../ui';
import { STRUCTURES, UNITS, mapDef, simContent } from './content';
import { SkirmishAi } from '../ai';

/** Hash exchange interval for desync detection. */
const HASH_EVERY = 50;
/** Never simulate more than this many ticks in one visible frame. */
const MAX_CATCHUP = 10;
/** Hidden tabs get no rAF; keep stepping from a timer so peers don't stall on us. */
const HIDDEN_CATCHUP = 40;
/** A backlog this big means we rejoined and are replaying the command log. */
const FAST_FORWARD_BACKLOG = 20;

export interface MatchOptions {
  setup: MatchSetup;
  mode: MatchMode;
  net: NetSession;
  localPlayer: PlayerId;
  app: UiApp;
  canvas: HTMLCanvasElement;
  /** Watching a replay: its log (net is then a ReplaySession over it). */
  replay?: ReplayFile;
  /** Replay transport (play/pause, speed, seek, perspective), handled by the game layer. */
  replayControls?: ReplayControls;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];

/** Runs one match: sim + net + render + audio + HUD, and the frame loop. */
export class Match {
  readonly sim: Simulation;
  readonly renderer: GameRenderer;
  readonly ui: MatchUi;
  private readonly net: NetSession;
  private readonly audio: AudioManager;
  private readonly ais: SkirmishAi[] = [];
  private acc = 0;
  private last = performance.now();
  private running = true;
  private paused = false;
  private hiddenTimer: ReturnType<typeof setInterval> | undefined;
  /** Skirmish/replay game speed (1 = normal). Online matches always run at 1. */
  speed = 1;
  /** Turns that carried commands, and state hashes: the replay of this match. */
  private readonly turns: Turn[] = [];
  private readonly hashes: [Tick, number][] = [];
  private readonly matchId = Math.floor(Math.random() * 0xffffffff).toString(16);
  /** Replay reached the end of its log. */
  ended = false;
  /** Extra listener for each step's events (the tutorial director). */
  onEvents: ((events: SimEvent[]) => void) | null = null;
  /** Dev/playtest: an AI of this difficulty also plays the local player's side. */
  autoplay: 'easy' | 'normal' | 'hard' | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly opts: MatchOptions) {
    const { setup, net, localPlayer, app, canvas } = opts;
    const map = mapDef(setup.mapId);
    this.net = net;
    app.setLoadingProgress(0.3, 'Building the battlefield');
    this.sim = new Simulation(setup, simContent(setup.mapId));
    app.setLoadingProgress(0.6, 'Loading units');
    // Display colors (accessibility palettes) never reach the sim: it keeps the canonical setup.
    const shown = displaySetup(setup, localPlayer, app.settings.get().teamPalette);
    this.renderer = new GameRenderer({ canvas, mapSize: map.size, units: UNITS, players: shown.players, localPlayer, map });
    this.renderer.setQuality(app.settings.get().graphics);
    const localSlot = setup.players.find((p) => p.id === localPlayer);
    // Co-commanders hear their shared army's voices.
    this.audio = new AudioManager(localSlot?.army ?? localPlayer, { team: localSlot?.team, units: UNITS });

    const r = this.renderer;
    r.cam.panKeys = () => {
      const k = app.settings.get().keybinds;
      return { up: k.panUp, down: k.panDown, left: k.panLeft, right: k.panRight };
    };
    // The spawn the sim gave our army (co-commanders look at the army they share).
    const armyOwner = localSlot?.army ?? localPlayer;
    const spawnIdx = assignSpawns(map, setup.players).get(armyOwner) ?? Math.max(0, armyOwner) % map.spawns.length;
    const spawn = map.spawns[spawnIdx];
    r.cam.lookAt(spawn.x, spawn.z);
    this.refreshViews();

    this.ui = app.createMatchUi({
      canvas,
      sim: this.sim,
      picker: r,
      camera: { lookAt: (x, z) => r.cam.lookAt(x, z), get target() { return r.cam.target; } },
      setup: shown,
      localPlayer,
      units: UNITS,
      structures: STRUCTURES,
      map,
      mode: opts.mode,
      render: { minimapImage: r.terrain.minimapImage() },
      issue: (cmd) => {
        net.submit(cmd);
        r.markCommand(cmd);
      },
      onSelectionChange: (ids) => {
        r.setSelection(ids);
        if (ids.length) this.audio.uiSelect(ids, this.sim);
      },
      onPauseChange: (p) => (this.paused = p && isLocalMode(opts.mode)),
      onDesyncReport: () => this.downloadDesyncReport(),
      onSpeedStep: (dir) => this.stepSpeed(dir),
      replay: opts.replayControls,
    });

    this.setupAi();
    this.watchNet();
  }

  start(): void {
    const loop = () => {
      if (!this.running) return;
      this.frame(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // Background tabs get no rAF (and not every browser reports document.hidden for them), so
    // step from a timer whenever frames stop arriving; otherwise every peer stalls on us.
    this.hiddenTimer = setInterval(() => {
      const now = performance.now();
      if (this.running && now - this.last > 300) this.frame(now, true);
    }, 250);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.hiddenTimer);
    for (const off of this.offs) off();
    this.net.dispose();
    this.renderer.dispose();
    this.audio.dispose();
  }

  private resyncAi: () => void = () => {};

  /**
   * Dev/playtest (skirmish only): simulate `seconds` of game time right now, AIs included, without
   * drawing in between. Views are rebuilt at the end.
   */
  fastForward(seconds: number): void {
    if (this.opts.mode !== 'skirmish' && this.opts.mode !== 'replay') return;
    this.runTo(this.sim.tick + Math.round(seconds * 1000 / TICK_MS));
  }

  /** Simulate up to `end` without drawing (AIs included), then rebuild the views. */
  runTo(end: Tick): void {
    while (this.sim.tick < end && this.sim.winner === null) {
      for (const ai of this.ais) ai.update();
      const turn = this.net.pollTurn(this.sim.tick);
      if (!turn) break;
      this.record(turn);
      const events: SimEvent[] = this.sim.step(turn.commands);
      if (this.sim.proposedEvents.length) events.push(...this.sim.proposedEvents);
      this.renderer.handleEvents(this.sim, events.filter((e) => e.type === 'removed' || e.type === 'spawned' || e.type === 'placed' || e.type === 'built'));
      this.ui.handleEvents(events);
      this.onEvents?.(events);
    }
    this.refreshViews();
  }

  /** Skirmish/replay speed hotkeys walk a fixed ladder of speeds. */
  stepSpeed(dir: 1 | -1): void {
    if (!isLocalMode(this.opts.mode)) return;
    const i = SPEEDS.findIndex((s) => s >= this.speed - 1e-6);
    this.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))];
    this.ui.toastSpeed?.(this.speed);
  }

  setPaused(p: boolean): void {
    this.paused = p && isLocalMode(this.opts.mode);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Everything needed to watch this match again. */
  commandLog(): CommandLog {
    return { matchId: this.matchId, setup: this.opts.setup, turnTicks: 1, endTick: this.sim.tick, turns: [...this.turns], hashes: [...this.hashes] };
  }

  private record(turn: Turn): void {
    if (this.opts.mode === 'replay') return;
    if (turn.commands.length) this.turns.push({ tick: turn.tick, commands: turn.commands });
  }

  /** Turn the local player's autoplay AI on or off (dev/playtest). */
  setAutoplay(d: 'easy' | 'normal' | 'hard' | null): void {
    this.autoplay = this.opts.mode === 'skirmish' ? d : null;
    this.resyncAi();
  }

  private lockstep(): LockstepSession | null {
    const n = this.net as Partial<LockstepSession>;
    return typeof n.controls === 'function' && n.events ? (this.net as LockstepSession) : null;
  }

  /** Skirmish AIs for AI slots this peer controls (all of them in skirmish; the controlling peer's online). */
  private setupAi(): void {
    const ls = this.lockstep();
    const controls = (p: PlayerId) => (ls ? ls.controls(p) : true);
    const issue = (cmd: Parameters<NetSession['submit']>[0], player: PlayerId) => this.net.submit(cmd, player);
    const sync = () => {
      this.ais.length = 0;
      for (const p of this.opts.setup.players) {
        const auto = this.autoplay && p.id === this.opts.localPlayer;
        // Replays replay the AIs' recorded orders; the tutorial's opponent stays passive.
        if (this.opts.mode === 'replay' || (this.opts.mode === 'tutorial' && !auto)) continue;
        if ((p.kind === 'ai' && controls(p.id)) || auto) {
          const setup = auto ? { ...this.opts.setup, players: this.opts.setup.players.map((s) => (s.id === p.id ? { ...s, aiDifficulty: this.autoplay! } : s)) } : this.opts.setup;
          this.ais.push(new SkirmishAi(p.id, setup, this.sim, mapDef(this.opts.setup.mapId), issue, this.opts.setup.seed));
        }
      }
    };
    this.resyncAi = sync;
    sync();
    if (ls) this.offs.push(ls.events.on('control', sync));
  }

  private watchNet(): void {
    const ls = this.lockstep();
    if (!ls) return;
    const names = new Map(this.opts.setup.players.map((p) => [p.id, p.name]));
    this.offs.push(
      ls.events.on('status', (s) => {
        const waiting = s.phase === 'waiting' && s.waitingSince !== null && performance.now() - s.waitingSince > 1000;
        const pings = Object.values(s.rtt).filter((v): v is number => typeof v === 'number');
        this.ui.setNetStatus({
          waitingFor: waiting ? s.waitingFor.map((p) => names.get(p) ?? `Player ${p + 1}`) : s.phase === 'catchingUp' ? ['catching up'] : [],
          pingMs: pings.length ? Math.max(...pings) : undefined,
        });
      }),
      ls.events.on('desync', (d) => {
        console.error('[match] desync', d);
        this.ui.setNetStatus({ desyncTick: d.tick });
      }),
    );
  }

  private downloadDesyncReport(): void {
    const ls = this.lockstep();
    const report = { tick: this.sim.tick, hash: this.sim.hash(), setup: this.opts.setup, log: ls?.commandLog?.() };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: 'application/json' }));
    a.download = `frontline-desync-${this.sim.tick}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Make the renderer's views match the sim (start, and after fast-forwarding). */
  private refreshViews(): void {
    for (const e of this.sim.entities()) this.renderer.handleEvents(this.sim, [{ type: 'spawned', id: e.id }]);
  }

  private frame(now: number, background = false): void {
    const hidden = background || document.hidden;
    const dt = Math.min((now - this.last) / 1000, hidden ? 2 : 0.25);
    this.last = now;
    if (!this.paused) {
      this.acc += dt * 1000 * (isLocalMode(this.opts.mode) ? this.speed : 1);
      for (const ai of this.ais) ai.update();
    } else this.acc = 0;

    const backlog = this.net.backlogTicks?.(this.sim.tick) ?? 0;
    const ff = backlog > FAST_FORWARD_BACKLOG;
    const cap = ff ? backlog : hidden ? HIDDEN_CATCHUP : MAX_CATCHUP * Math.max(1, Math.ceil(this.speed));
    let steps = 0;
    while (!this.paused && (ff || this.acc >= TICK_MS) && steps < cap) {
      const turn = this.net.pollTurn(this.sim.tick);
      if (!turn) {
        this.acc = Math.min(this.acc, TICK_MS); // stalled waiting on a peer (or the replay ended)
        if (this.opts.mode === 'replay') this.ended = true;
        break;
      }
      this.record(turn);
      if (!ff) this.renderer.beforeStep(this.sim);
      const events: SimEvent[] = this.sim.step(turn.commands);
      if (this.sim.proposedEvents.length) events.push(...this.sim.proposedEvents);
      if (!ff) {
        this.renderer.handleEvents(this.sim, events);
        this.audio.handleEvents(events, this.sim);
      }
      this.ui.handleEvents(events);
      this.onEvents?.(events);
      if (this.sim.tick % HASH_EVERY === 0) {
        const hash = this.sim.hash();
        this.net.reportHash(this.sim.tick, hash);
        if (this.opts.mode !== 'replay') this.hashes.push([this.sim.tick, hash]);
      }
      if (!ff) this.acc -= TICK_MS;
      steps++;
    }
    if (ff && steps) this.refreshViews();
    if (!ff && steps === cap) this.acc = 0;
    if (hidden) return;

    this.renderer.frame(this.sim, Math.min(this.acc / TICK_MS, 1), dt);
    this.audio.setListenerFromCamera(this.renderer.cam.camera.position, this.renderer.cam.target);
    this.audio.update(this.sim, dt);
    this.ui.frame(dt);
  }
}
