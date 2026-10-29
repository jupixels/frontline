import { AudioManager } from '../audio/audio';
import type { NetSession } from '../net/session';
import { GameRenderer } from '../render/renderer';
import type { MatchSetup } from '../shared/types';
import { TICK_MS } from '../shared/types';
import { Simulation } from '../sim/simulation';
import type { SimContent } from '../sim/world';
import { Hud } from '../ui/hud';
import { InputController } from '../ui/input';

/** Hash exchange interval for desync detection. */
const HASH_EVERY = 50;
/** Never simulate more than this many ticks in one frame (tab was in background, etc.). */
const MAX_CATCHUP = 10;

/** Wires sim + net + render + audio + ui for one match and runs the frame loop. */
export class Match {
  readonly sim: Simulation;
  readonly renderer: GameRenderer;
  private readonly audio: AudioManager;
  private readonly input: InputController;
  private readonly hud: Hud;
  private acc = 0;
  private last = performance.now();
  private running = true;

  constructor(
    setup: MatchSetup,
    content: SimContent,
    private readonly net: NetSession,
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
  ) {
    this.sim = new Simulation(setup, content);
    this.renderer = new GameRenderer({ canvas, mapSize: content.map.size, units: content.units, players: setup.players });
    this.audio = new AudioManager(net.localPlayer);
    this.hud = new Hud(uiRoot);
    this.input = new InputController(canvas, this.sim, this.renderer, net.localPlayer, (cmd) => net.submit(cmd), (ids) => {
      this.renderer.setSelection(ids);
      if (ids.length) this.audio.uiSelect();
    });

    const spawn = content.map.spawns[net.localPlayer % content.map.spawns.length];
    this.renderer.cam.lookAt(spawn.x, spawn.z);
    for (const e of this.sim.entities()) this.renderer.handleEvents(this.sim, [{ type: 'spawned', id: e.id }]);
  }

  start(): void {
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    this.net.dispose();
  }

  private frame(now: number): void {
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    this.acc += dt * 1000;

    let steps = 0;
    while (this.acc >= TICK_MS && steps < MAX_CATCHUP) {
      const turn = this.net.pollTurn(this.sim.tick);
      if (!turn) {
        this.acc = Math.min(this.acc, TICK_MS); // stalled waiting on a peer
        break;
      }
      this.renderer.beforeStep(this.sim);
      const events = this.sim.step(turn.commands);
      this.renderer.handleEvents(this.sim, events);
      this.audio.handleEvents(events);
      if (this.sim.tick % HASH_EVERY === 0) this.net.reportHash(this.sim.tick, this.sim.hash());
      this.acc -= TICK_MS;
      steps++;
    }
    if (steps === MAX_CATCHUP) this.acc = 0;

    this.input.prune();
    this.renderer.frame(this.sim, Math.min(this.acc / TICK_MS, 1), dt);
    this.hud.update(this.sim, this.net.localPlayer, this.input.selection.size, dt);
  }
}
