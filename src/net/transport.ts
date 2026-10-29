import { Emitter } from './emitter';
import type { NetEnv } from './env';
import type { NetMessage, PeerId } from './protocol';

/**
 * A room of peers that can exchange JSON messages. Implementations: `trysteroTransport`
 * (real WebRTC, `./trystero.ts`) and `LoopbackNetwork` (in-memory, tests and dev).
 *
 * Delivery is reliable per peer, but callers must not rely on ordering across reconnects or
 * strategies; the lockstep protocol tolerates reordering.
 */
export interface Transport {
  readonly selfId: PeerId;
  readonly events: Emitter<TransportEvents>;
  /** Currently connected peers (not including self). */
  peers(): PeerId[];
  /** Send to one peer, a list of peers, or everyone when `to` is omitted. */
  send(msg: NetMessage, to?: PeerId | PeerId[]): void;
  readonly status: TransportStatus;
  close(): void;
}

export interface TransportEvents {
  message: { msg: NetMessage; from: PeerId };
  peerJoin: PeerId;
  peerLeave: PeerId;
  status: TransportStatus;
}

export interface StrategyStatus {
  name: string;
  relaysOpen: number;
  relaysTotal: number;
  /** Set when the strategy could not be loaded or joined at all. */
  error?: string;
}

export interface TransportStatus {
  state: 'connecting' | 'ready' | 'failed' | 'closed';
  error?: NetErrorCode;
  strategies: StrategyStatus[];
}

/** Opens (or joins) the room `roomId`. Rejects with a `NetError` when signaling is unusable. */
export type TransportFactory = (roomId: string, env: NetEnv) => Promise<Transport>;

export type NetErrorCode =
  /** No signaling relay (Nostr / MQTT / torrent tracker) could be reached. */
  | 'signaling-unavailable'
  /** This browser has no RTCPeerConnection. */
  | 'webrtc-unsupported'
  /** Signaling works but the host never answered: wrong code, host gone, or P2P blocked by NAT. */
  | 'host-unreachable'
  /** The host refused us; see `NetError.reason`. */
  | 'rejected'
  | 'kicked'
  /** The transport was closed by us. */
  | 'closed';

const MESSAGES: Record<NetErrorCode, string> = {
  'signaling-unavailable':
    "Couldn't reach any matchmaking relay. Check your internet connection or try another network, then retry.",
  'webrtc-unsupported': 'This browser does not support WebRTC peer-to-peer connections.',
  'host-unreachable':
    "Couldn't connect to the host. Check the room code. If it's right, your network may block peer-to-peer connections (strict NAT or firewall).",
  rejected: 'The host refused the connection.',
  kicked: 'You were removed from the lobby by the host.',
  closed: 'Connection closed.',
};

export class NetError extends Error {
  constructor(
    readonly code: NetErrorCode,
    readonly reason?: string,
    message = MESSAGES[code] + (reason ? ` (${reason})` : ''),
  ) {
    super(message);
    this.name = 'NetError';
  }
}

/** Shared bookkeeping for transports: status + events. */
export abstract class BaseTransport implements Transport {
  readonly events = new Emitter<TransportEvents>();
  status: TransportStatus = { state: 'connecting', strategies: [] };

  abstract readonly selfId: PeerId;
  abstract peers(): PeerId[];
  abstract send(msg: NetMessage, to?: PeerId | PeerId[]): void;
  abstract close(): void;

  protected setStatus(status: TransportStatus): void {
    this.status = status;
    this.events.emit('status', status);
  }
}
