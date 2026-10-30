import { AudioManager } from '../audio/audio';
import type { LockstepSession } from '../net';
import type { NetSession } from '../net/session';
import { GameRenderer } from '../render/renderer';
import type { SimEvent } from '../shared/events';
import type { MatchSetup, PlayerId } from '../shared/types';
import { TICK_MS } from '../shared/types';
import { Simulation } from '../sim/simulation';
import type { MatchMode, MatchUi, UiApp } from '../ui';
import { STRUCTURES, UNITS, mapDef, simContent } from './content';
import { PlaceholderAi } from './placeholderAi';

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
}

/** Runs one match: sim + net + render + audio + HUD, and the frame loop. */
export class Match {
  readonly sim: Simulation;
  readonly renderer: GameRenderer;
  readonly ui: MatchUi;
  private readonly net: NetSession;
  private readonly audio: AudioManager;
  private readonly ais: PlaceholderAi[] = [];
  private acc = 0;
  private last = performance.now();
  private running = true;
  private paused = false;
  private hiddenTimer: ReturnType<typeof setInterval> | undefined;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly opts: MatchOptions) {
    const { setup, net, localPlayer, app, canvas } = opts;
    const map = mapDef(setup.mapId);
    this.net = net;
    app.setLoadingProgress(0.3, 'Building the battlefield');
    this.sim = new Simulation(setup, simContent(setup.mapId));
    app.setLoadingProgress(0.6, 'Loading units');
    this.renderer = new GameRenderer({ canvas, mapSize: map.size, units: UNITS, players: setup.players, localPlayer, map });
    this.renderer.setQuality(app.settings.get().graphics);
    const localTeam = setup.players.find((p) => p.id === localPlayer)?.team;
    this.audio = new AudioManager(localPlayer, { team: localTeam, units: UNITS });

    const r = this.renderer;
    const spawn = map.spawns[Math.max(0, localPlayer) % map.spawns.length];
    r.cam.lookAt(spawn.x, spawn.z);
    this.refreshViews();

    this.ui = app.createMatchUi({
      canvas,
      sim: this.sim,
      picker: r,
      camera: { lookAt: (x, z) => r.cam.lookAt(x, z), get target() { return r.cam.target; } },
      setup,
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
      onPauseChange: (p) => (this.paused = p && opts.mode === 'skirmish'),
      onDesyncReport: () => this.downloadDesyncReport(),
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

  private lockstep(): LockstepSession | null {
    const n = this.net as Partial<LockstepSession>;
    return typeof n.controls === 'function' && n.events ? (this.net as LockstepSession) : null;
  }

  /** Placeholder AIs for AI slots this peer controls (all of them in skirmish; the host's online). */
  private setupAi(): void {
    const ls = this.lockstep();
    const controls = (p: PlayerId) => (ls ? ls.controls(p) : true);
    const issue = (cmd: Parameters<NetSession['submit']>[0], player: PlayerId) => this.net.submit(cmd, player);
    const sync = () => {
      this.ais.length = 0;
      for (const p of this.opts.setup.players) {
        if (p.kind === 'ai' && controls(p.id)) this.ais.push(new PlaceholderAi(p.id, this.opts.setup, this.sim, issue));
      }
    };
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
      this.acc += dt * 1000;
      for (const ai of this.ais) ai.update(dt);
    } else this.acc = 0;

    const backlog = this.net.backlogTicks?.(this.sim.tick) ?? 0;
    const ff = backlog > FAST_FORWARD_BACKLOG;
    const cap = ff ? backlog : hidden ? HIDDEN_CATCHUP : MAX_CATCHUP;
    let steps = 0;
    while (!this.paused && (ff || this.acc >= TICK_MS) && steps < cap) {
      const turn = this.net.pollTurn(this.sim.tick);
      if (!turn) {
        this.acc = Math.min(this.acc, TICK_MS); // stalled waiting on a peer
        break;
      }
      if (!ff) this.renderer.beforeStep(this.sim);
      const events: SimEvent[] = this.sim.step(turn.commands);
      if (this.sim.proposedEvents.length) events.push(...this.sim.proposedEvents);
      if (!ff) {
        this.renderer.handleEvents(this.sim, events);
        this.audio.handleEvents(events, this.sim);
      }
      this.ui.handleEvents(events);
      if (this.sim.tick % HASH_EVERY === 0) this.net.reportHash(this.sim.tick, this.sim.hash());
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
