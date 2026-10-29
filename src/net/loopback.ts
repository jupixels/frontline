import type { NetEnv } from './env';
import type { NetMessage, PeerId } from './protocol';
import { BaseTransport, type Transport, type TransportFactory } from './transport';

export interface LoopbackOptions {
  /** One-way base latency in ms. */
  latencyMs?: number;
  /** Extra uniform random delay 0..jitterMs per message. */
  jitterMs?: number;
  /** When false (default true), each message is delayed independently, so they can arrive out of order. */
  ordered?: boolean;
  /** Delay before two peers in a room see each other. */
  connectMs?: number;
  seed?: number;
}

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled?: boolean;
}

/**
 * In-memory network on a virtual clock. Every transport opened through `factory` joins the
 * same set of rooms; messages are JSON-cloned like the real wire and delivered after a
 * simulated latency. Drive time with `advance(ms)`. Its `env` gives sessions the same clock.
 */
export class LoopbackNetwork {
  private time = 0;
  private seq = 0;
  private timers: Timer[] = [];
  private rng: number;
  private nextPeer = 0;
  private readonly rooms = new Map<string, Set<LoopbackTransport>>();
  /** Last scheduled delivery time per directed link, for ordered delivery. */
  private readonly linkClock = new Map<string, number>();
  readonly opts: Required<LoopbackOptions>;

  readonly env: NetEnv = {
    now: () => this.time,
    setTimeout: (fn, ms) => this.schedule(ms, fn),
    clearTimeout: (h) => {
      if (h) (h as Timer).cancelled = true;
    },
    random: () => this.rand(),
  };

  constructor(opts: LoopbackOptions = {}) {
    this.opts = { latencyMs: 20, jitterMs: 0, ordered: true, connectMs: 30, seed: 1, ...opts };
    this.rng = this.opts.seed >>> 0 || 1;
  }

  get now(): number {
    return this.time;
  }

  /** A TransportFactory for lobby / session code. */
  readonly factory: TransportFactory = async (roomId) => this.open(roomId);

  open(roomId: string, id?: PeerId): LoopbackTransport {
    const t = new LoopbackTransport(this, roomId, id ?? `peer${this.nextPeer++}`);
    let room = this.rooms.get(roomId);
    if (!room) this.rooms.set(roomId, (room = new Set()));
    for (const other of room) {
      this.schedule(this.opts.connectMs, () => {
        if (t.closed || other.closed) return;
        t.link(other);
        other.link(t);
      });
    }
    room.add(t);
    return t;
  }

  /** Run all events up to now + ms. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = this.popDue(end);
      if (!next) break;
      this.time = next.at;
      next.fn();
    }
    this.time = end;
  }

  /** Abruptly cut a peer off (like a crashed tab): others see peerLeave, no goodbye. */
  crash(t: LoopbackTransport): void {
    t.close();
  }

  /** @internal */
  deliver(from: LoopbackTransport, to: LoopbackTransport, msg: NetMessage): void {
    const wire = JSON.stringify(msg);
    const { latencyMs, jitterMs, ordered } = this.opts;
    let at = this.time + latencyMs + (jitterMs ? this.rand() * jitterMs : 0);
    const key = `${from.selfId}>${to.selfId}`;
    if (ordered) {
      at = Math.max(at, this.linkClock.get(key) ?? 0);
      this.linkClock.set(key, at);
    }
    this.schedule(at - this.time, () => {
      if (to.closed || !to.isLinked(from.selfId)) return;
      to.receive(JSON.parse(wire) as NetMessage, from.selfId);
    });
  }

  /** @internal */
  remove(t: LoopbackTransport): void {
    this.rooms.get(t.roomId)?.delete(t);
  }

  schedule(ms: number, fn: () => void): Timer {
    const timer: Timer = { at: this.time + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(timer);
    return timer;
  }

  private popDue(end: number): Timer | undefined {
    let best = -1;
    for (let i = 0; i < this.timers.length; i++) {
      const t = this.timers[i];
      if (t.cancelled || t.at > end) continue;
      const b = this.timers[best];
      if (best < 0 || t.at < b.at || (t.at === b.at && t.seq < b.seq)) best = i;
    }
    if (best < 0) {
      this.timers = this.timers.filter((t) => !t.cancelled);
      return undefined;
    }
    return this.timers.splice(best, 1)[0];
  }

  private rand(): number {
    // xorshift32: fine for test jitter, never used by the sim.
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }
}

export class LoopbackTransport extends BaseTransport implements Transport {
  closed = false;
  private readonly linked = new Map<PeerId, LoopbackTransport>();

  constructor(
    private readonly net: LoopbackNetwork,
    readonly roomId: string,
    readonly selfId: PeerId,
  ) {
    super();
    this.status = { state: 'ready', strategies: [{ name: 'loopback', relaysOpen: 1, relaysTotal: 1 }] };
  }

  peers(): PeerId[] {
    return [...this.linked.keys()];
  }

  isLinked(id: PeerId): boolean {
    return this.linked.has(id);
  }

  send(msg: NetMessage, to?: PeerId | PeerId[]): void {
    if (this.closed) return;
    const targets = to === undefined ? [...this.linked.keys()] : Array.isArray(to) ? to : [to];
    for (const id of targets) {
      const peer = this.linked.get(id);
      if (peer) this.net.deliver(this, peer, msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.net.remove(this);
    for (const peer of this.linked.values()) {
      this.net.schedule(this.net.opts.latencyMs, () => peer.unlink(this.selfId));
    }
    this.linked.clear();
    this.setStatus({ ...this.status, state: 'closed' });
  }

  /** @internal */
  link(other: LoopbackTransport): void {
    if (this.linked.has(other.selfId)) return;
    this.linked.set(other.selfId, other);
    this.events.emit('peerJoin', other.selfId);
  }

  /** @internal */
  unlink(id: PeerId): void {
    if (!this.linked.delete(id)) return;
    this.events.emit('peerLeave', id);
  }

  /** @internal */
  receive(msg: NetMessage, from: PeerId): void {
    if (!this.closed) this.events.emit('message', { msg, from });
  }
}
