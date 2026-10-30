import type { NetSession } from '../src/net/session';
import { joinLobby, hostLobby, type Lobby, type LobbyOptions } from '../src/net/lobby';
import type { LockstepSession } from '../src/net/lockstep';
import { LoopbackNetwork, type LoopbackOptions, type LoopbackTransport } from '../src/net/loopback';
import type { TransportFactory } from '../src/net/transport';
import type { MatchSetup } from '../src/shared/types';
import { TICK_MS } from '../src/shared/types';
import { Prng } from '../src/sim/math/prng';
import { Simulation } from '../src/sim/simulation';
import { testContent } from './fixtures';

const HASH_EVERY = 50;
const MAX_CATCHUP = 10;
/** Mirrors src/game/match.ts: hidden tabs step from a timer with a larger catch-up cap. */
const HIDDEN_CATCHUP = 40;

/** In-memory storage standing in for sessionStorage. */
export class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

/** One virtual browser tab: a lobby, and once started, a sim driven like src/game/match.ts. */
export class VirtualPeer {
  lobby!: Lobby;
  sim: Simulation | null = null;
  session: LockstepSession | null = null;
  /** sim.tick → hash, recorded every HASH_EVERY ticks. */
  readonly hashes = new Map<number, number>();
  frozen = false;
  /** Simulate a background tab whose timers fire only every `throttleMs` (browsers: ~1000). */
  throttleMs = 0;
  private throttled = 0;
  /** Uncapped catch-up (what the match loop should do while a rejoin backlog is large). */
  fastForward = true;
  submitted = 0;
  private acc = 0;
  private readonly script: Prng;
  readonly storage = new MemStorage();
  transport?: LoopbackTransport;

  constructor(
    readonly name: string,
    seed: number,
  ) {
    this.script = new Prng(seed);
  }

  attach(lobby: Lobby): void {
    this.lobby = lobby;
    if (lobby.match) this.begin(lobby.match.setup, lobby.match.session);
    lobby.on('start', ({ setup, session }) => this.begin(setup, session));
  }

  begin(setup: MatchSetup, session: LockstepSession): void {
    this.sim = new Simulation(setup, testContent());
    this.session = session;
    this.acc = 0;
  }

  /** Advance this tab's frame loop by `ms` of wall time. */
  frame(ms: number): void {
    const sim = this.sim;
    const net = this.session;
    if (!sim || !net || this.frozen) return;
    if (this.throttleMs) {
      this.throttled += ms;
      if (this.throttled < this.throttleMs) return;
      ms = Math.min(this.throttled, 2000); // match.ts clamps dt to 2 s when hidden
      this.throttled = 0;
    }
    this.acc += ms;
    const ff = this.fastForward && net.backlogTicks(sim.tick) > 20;
    let steps = 0;
    const cap = this.throttleMs ? HIDDEN_CATCHUP : MAX_CATCHUP;
    while (ff ? steps < 200_000 : this.acc >= TICK_MS && steps < cap) {
      const turn = net.pollTurn(sim.tick);
      if (!turn) {
        this.acc = Math.min(this.acc, TICK_MS);
        break;
      }
      sim.step(turn.commands);
      if (sim.tick % HASH_EVERY === 0) {
        const h = sim.hash();
        this.hashes.set(sim.tick, h);
        net.reportHash(sim.tick, h);
      }
      if (!ff) this.acc -= TICK_MS;
      steps++;
      if (sim.tick % 15 === 0) this.issueCommands(net, sim);
      if (ff && net.backlogTicks(sim.tick) === 0) break;
    }
    if (!ff && steps === cap) this.acc = 0;
  }

  /** Random but legal orders for every player this tab controls (its human and any AI). */
  private issueCommands(net: LockstepSession, sim: Simulation): void {
    for (const player of net.controlledPlayers()) {
      if (this.script.next() < 0.5) continue;
      // Now and then: put up a power plant, or demolish/cancel what's standing (lockstep must agree on both).
      const roll = this.script.next();
      const own = [...sim.entities()].filter((e) => e.owner === player);
      const eng = own.find((e) => e.type === 'engineer');
      const hq = own.find((e) => e.type === 'hq');
      if (roll < 0.08 && eng && hq) {
        net.submit({ type: 'build', builder: eng.id, structure: 'power_plant', at: { x: hq.pos.x + this.script.range(-50, 50), z: hq.pos.z + this.script.range(-50, 50) }, rotation: 0 }, player);
        this.submitted++;
        continue;
      }
      if (roll < 0.14) {
        const structures = own.filter((e) => e.kind === 'structure').map((e) => e.id);
        if (structures.length) {
          net.submit({ type: 'demolish', structures }, player);
          this.submitted++;
          continue;
        }
      }
      const units = own.filter((e) => e.kind === 'unit' && this.script.next() < 0.6).map((e) => e.id);
      if (!units.length) continue;
      net.submit({ type: 'move', units, target: { x: this.script.range(-200, 200), z: this.script.range(-200, 200) } }, player);
      this.submitted++;
    }
  }
}

export class TestWorld {
  readonly net: LoopbackNetwork;
  readonly peers: VirtualPeer[] = [];

  constructor(opts: LoopbackOptions = {}) {
    this.net = new LoopbackNetwork(opts);
  }

  factoryFor(peer: VirtualPeer): TransportFactory {
    return async (room) => {
      const t = this.net.open(room, peer.name);
      peer.transport = t;
      return t;
    };
  }

  opts(peer: VirtualPeer, extra: Partial<LobbyOptions> = {}): LobbyOptions {
    return { name: peer.name, transport: this.factoryFor(peer), env: this.net.env, storage: peer.storage, ...extra };
  }

  async host(name: string, extra: Partial<LobbyOptions> = {}): Promise<VirtualPeer> {
    const peer = new VirtualPeer(name, this.peers.length + 1);
    this.peers.push(peer);
    peer.attach(await hostLobby(this.opts(peer, extra)));
    return peer;
  }

  async join(name: string, code: string, extra: Partial<LobbyOptions> = {}): Promise<VirtualPeer> {
    const peer = new VirtualPeer(name, this.peers.length + 1);
    this.peers.push(peer);
    const p = joinLobby(code, this.opts(peer, extra));
    const lobby = await this.until(p);
    peer.attach(lobby);
    return peer;
  }

  /** Run virtual time until `p` settles (yielding to real async work such as WebCrypto). */
  async until<T>(p: Promise<T>, maxMs = 30_000): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    p.then(
      (v) => ((done = true), (value = v)),
      (e) => ((done = true), (error = e)),
    );
    for (let t = 0; t < maxMs && !done; t += 5) {
      await tick();
      this.step(5);
    }
    await tick();
    if (!done) throw new Error('timed out');
    if (error) throw error;
    return value as T;
  }

  /** Advance network + every tab by ms in 5 ms steps. Yields to the event loop every `yieldEvery` steps. */
  async run(ms: number, yieldEvery = 20): Promise<void> {
    for (let t = 0, i = 0; t < ms; t += 5, i++) {
      this.step(5);
      if (i % yieldEvery === 0) await tick();
    }
  }

  step(ms: number): void {
    this.net.advance(ms);
    for (const p of this.peers) p.frame(ms);
  }
}

export function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Assert-friendly: ticks where both peers have hashes, and whether they all agree. */
export function compareHashes(peers: VirtualPeer[]): { common: number; mismatches: number[] } {
  const ticks = [...peers[0].hashes.keys()].filter((t) => peers.every((p) => p.hashes.has(t)));
  const mismatches = ticks.filter((t) => new Set(peers.map((p) => p.hashes.get(t))).size > 1);
  return { common: ticks.length, mismatches };
}

export type { NetSession };
