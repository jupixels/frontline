import type { JoinRoom, MessageAction, Room } from '@trystero-p2p/core';
import type { NetEnv } from './env';
import type { NetMessage, PeerId } from './protocol';
import { BaseTransport, NetError, type StrategyStatus, type Transport, type TransportFactory } from './transport';

/**
 * Real WebRTC transport via Trystero. Signaling goes over free public relays; game data goes
 * peer-to-peer over data channels.
 *
 * Every configured strategy is joined at once (Nostr and MQTT by default), so the room works
 * as long as any one relay network is reachable. If none of them has an open relay after
 * `fallbackAfterMs`, BitTorrent trackers are tried too. A peer reached through several
 * strategies counts once; messages go through the first strategy that connected it.
 */
export type StrategyName = 'nostr' | 'mqtt' | 'torrent';

export interface TrysteroOptions {
  /** Namespaces rooms so other Trystero apps on the same relays never see ours. */
  appId?: string;
  strategies?: StrategyName[];
  /** Added when no relay of `strategies` is open after `fallbackAfterMs`. */
  fallback?: StrategyName[];
  fallbackAfterMs?: number;
  /** Give up with `signaling-unavailable` when no relay at all is open after this long. */
  signalingTimeoutMs?: number;
  iceServers?: RTCIceServer[];
  /** Optional TURN servers (users may paste their own later). */
  turnServers?: RTCIceServer[];
}

/** Free public STUN servers. TURN is not free; ~10% of NATs need it (see GAME_PLAN §8). */
export const PUBLIC_STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export const DEFAULT_APP_ID = 'frontline-rts-v1';

interface StrategyModule {
  joinRoom: JoinRoom;
  getRelaySockets: () => Record<string, unknown>;
  selfId: string;
}

const LOADERS: Record<StrategyName, () => Promise<StrategyModule>> = {
  nostr: () => import('@trystero-p2p/nostr') as Promise<StrategyModule>,
  mqtt: () => import('@trystero-p2p/mqtt') as Promise<StrategyModule>,
  torrent: () => import('@trystero-p2p/torrent') as Promise<StrategyModule>,
};

interface Joined {
  name: StrategyName;
  mod?: StrategyModule;
  room?: Room;
  action?: MessageAction;
  peers: Set<PeerId>;
  error?: string;
}

export function trysteroTransport(opts: TrysteroOptions = {}): TransportFactory {
  return async (roomId, env) => {
    if (typeof RTCPeerConnection === 'undefined') throw new NetError('webrtc-unsupported');
    const t = new TrysteroTransport(roomId, env, opts);
    await t.connect();
    return t;
  };
}

function isOpen(socket: unknown): boolean {
  if (!socket || typeof socket !== 'object') return false;
  const s = socket as { readyState?: number; connected?: boolean };
  return s.readyState === 1 || s.connected === true;
}

class TrysteroTransport extends BaseTransport implements Transport {
  selfId: PeerId = '';
  private readonly joined: Joined[] = [];
  private closed = false;
  private pollTimer: unknown;
  private readonly appId: string;
  private readonly rtcConfig: RTCConfiguration;

  constructor(
    private readonly roomId: string,
    private readonly env: NetEnv,
    private readonly opts: TrysteroOptions,
  ) {
    super();
    this.appId = opts.appId ?? DEFAULT_APP_ID;
    this.rtcConfig = { iceServers: [...(opts.iceServers ?? PUBLIC_STUN), ...(opts.turnServers ?? [])] };
  }

  async connect(): Promise<void> {
    const strategies = this.opts.strategies ?? ['nostr', 'mqtt'];
    const fallback = this.opts.fallback ?? ['torrent'];
    const fallbackAfter = this.opts.fallbackAfterMs ?? 5000;
    const timeout = this.opts.signalingTimeoutMs ?? 12000;

    await Promise.all(strategies.map((s) => this.join(s)));
    const start = this.env.now();
    let fellBack = false;
    // Wait until at least one relay is open, falling back to more strategies as needed.
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.closed) return reject(new NetError('closed'));
        const status = this.strategyStatus();
        this.setStatus({ state: 'connecting', strategies: status });
        if (status.some((s) => s.relaysOpen > 0)) return resolve();
        const waited = this.env.now() - start;
        if (!fellBack && waited >= fallbackAfter) {
          fellBack = true;
          void Promise.all(fallback.filter((s) => !this.joined.some((j) => j.name === s)).map((s) => this.join(s)));
        }
        if (waited >= timeout) {
          this.setStatus({ state: 'failed', error: 'signaling-unavailable', strategies: status });
          this.close();
          return reject(new NetError('signaling-unavailable'));
        }
        this.env.setTimeout(check, 250);
      };
      check();
    });
    this.setStatus({ state: 'ready', strategies: this.strategyStatus() });
    // Keep relay health visible for the UI (e.g. a "relays: 3/5" debug readout).
    const poll = () => {
      if (this.closed) return;
      this.setStatus({ state: 'ready', strategies: this.strategyStatus() });
      this.pollTimer = this.env.setTimeout(poll, 5000);
    };
    this.pollTimer = this.env.setTimeout(poll, 5000);
  }

  private async join(name: StrategyName): Promise<void> {
    const j: Joined = { name, peers: new Set() };
    this.joined.push(j);
    try {
      j.mod = await LOADERS[name]();
      if (this.closed) return;
      this.selfId ||= j.mod.selfId;
      const room = j.mod.joinRoom({ appId: this.appId, rtcConfig: this.rtcConfig }, this.roomId, {
        onJoinError: (e) => {
          j.error = e.error;
          console.warn(`[net] ${name} join error`, e.error);
        },
      });
      j.room = room;
      j.action = room.makeAction('m', {
        onMessage: (data, ctx) => {
          if (!this.closed) this.events.emit('message', { msg: data as unknown as NetMessage, from: ctx.peerId });
        },
      });
      room.onPeerJoin = (id) => {
        j.peers.add(id);
        if (this.countRooms(id) === 1) this.events.emit('peerJoin', id);
      };
      room.onPeerLeave = (id) => {
        if (!j.peers.delete(id)) return;
        if (this.countRooms(id) === 0) this.events.emit('peerLeave', id);
      };
    } catch (err) {
      j.error = err instanceof Error ? err.message : String(err);
      console.warn(`[net] strategy ${name} unavailable`, err);
    }
  }

  private countRooms(id: PeerId): number {
    let n = 0;
    for (const j of this.joined) if (j.peers.has(id)) n++;
    return n;
  }

  private strategyStatus(): StrategyStatus[] {
    return this.joined.map((j) => {
      let sockets: unknown[] = [];
      try {
        sockets = j.mod ? Object.values(j.mod.getRelaySockets()) : [];
      } catch {
        // Some strategies throw before init; treat as no relays.
      }
      return { name: j.name, relaysOpen: sockets.filter(isOpen).length, relaysTotal: sockets.length, error: j.error };
    });
  }

  peers(): PeerId[] {
    const all = new Set<PeerId>();
    for (const j of this.joined) for (const p of j.peers) all.add(p);
    return [...all];
  }

  send(msg: NetMessage, to?: PeerId | PeerId[]): void {
    if (this.closed) return;
    const targets = to === undefined ? this.peers() : Array.isArray(to) ? to : [to];
    // Route each peer through the first strategy (in join order) that has it.
    const byStrategy = new Map<Joined, PeerId[]>();
    for (const id of targets) {
      const j = this.joined.find((x) => x.peers.has(id) && x.action);
      if (!j) continue;
      let list = byStrategy.get(j);
      if (!list) byStrategy.set(j, (list = []));
      list.push(id);
    }
    const data = msg as unknown as Parameters<MessageAction['send']>[0];
    for (const [j, ids] of byStrategy) {
      j.action!.send(data, { target: ids }).catch((err) => console.warn(`[net] send via ${j.name} failed`, err));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.env.clearTimeout(this.pollTimer);
    for (const j of this.joined) void j.room?.leave().catch(() => {});
    this.setStatus({ state: 'closed', strategies: this.strategyStatus() });
  }
}
