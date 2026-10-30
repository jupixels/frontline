import type { Command, PlayerCommand, Turn } from '../shared/commands';
import type { MatchSetup, PlayerId, Tick } from '../shared/types';
import { TICK_MS } from '../shared/types';
import { Emitter } from './emitter';
import { realEnv, sha256Hex, type NetEnv } from './env';
import type { CtlChange, NetMessage, PeerId, RawInput, RejoinRequest, Segment, StartInfo, SyncPayload } from './protocol';
import type { CommandLog } from './replay';
import type { NetSession } from './session';
import type { Transport } from './transport';

/**
 * Deterministic lockstep over a `Transport`.
 *
 * Time is split into blocks of `turnTicks` ticks (2 → 10 turns/s). Every controlling peer
 * sends exactly one `in` message per block, possibly empty, `delayBlocks` blocks ahead of its
 * own sim. A block is applied (its commands at the block's first tick, ordered by player id
 * then submission order) once every player that is active in that block has input for it;
 * until then `pollTurn` returns null and the match loop stalls.
 *
 * The input delay adapts to measured RTT and is purely local: a peer may send further ahead
 * at any time without coordinating, because receivers only care that each block arrives.
 *
 * Who sends for which player is described by `Segment`s. Departures close a segment at an
 * agreed block (decided by the authority from every survivor's report, so nobody has applied
 * past it), AI players move to the new authority, and a rejoiner gets a new segment that
 * starts at a future block. Changes that take effect at block b ride in the authority's own
 * input for b, so no peer can apply b without knowing about them.
 *
 * The authority is the connected, active peer with the lowest human player id; it changes
 * automatically when that peer leaves (host migration).
 */
export interface LockstepConfig {
  transport: Transport;
  start: StartInfo;
  env?: NetEnv;
  /** Set for a peer that rejoins a running match. */
  sync?: SyncPayload;
  minDelayBlocks?: number;
  maxDelayBlocks?: number;
  /** Called by `dispose()` (the lobby closes its transport here). */
  onDispose?: () => void;
}

export interface SessionStatus {
  phase: 'running' | 'waiting' | 'catchingUp' | 'dropped' | 'closed';
  /** Players whose input the next turn is waiting for. Empty unless phase is 'waiting'. */
  waitingFor: PlayerId[];
  /** env.now() when the current wait started. UIs usually show an overlay after ~1 s. */
  waitingSince: number | null;
  inputDelayTicks: number;
  /** Smoothed round-trip time per remote human player, ms. */
  rtt: Partial<Record<PlayerId, number>>;
  /** Human player of the current authority (host). */
  authority: PlayerId;
}

export interface DesyncInfo {
  tick: Tick;
  /** State hash per human player. */
  hashes: Partial<Record<PlayerId, number>>;
}

export interface SessionEvents {
  status: SessionStatus;
  desync: DesyncInfo;
  /** A player's input stops after `tick`; its units keep their last orders (go idle). */
  playerLeft: { player: PlayerId; tick: Tick };
  /** A player is controlled again from `tick` on. */
  playerRejoined: { player: PlayerId; tick: Tick };
  /** The set of players this peer sends for changed (e.g. AI slots moved here on host migration). */
  control: { players: PlayerId[] };
  authority: { player: PlayerId; isSelf: boolean };
  /** Other peers dropped us (we were unreachable). Rejoin through the lobby. */
  dropped: Record<string, never>;
}

interface DropState {
  /** Reports collected while we are authority, by reporting peer. */
  reports: Map<PeerId, { max: number; inputs: RawInput[] }>;
  reportedTo?: PeerId;
}

interface PeerRtt {
  avg: number;
  dev: number;
}

/** How many applied blocks of raw inputs we keep (drop reports and resends need recent ones). */
const KEEP_BLOCKS = 300;
const RESEND_BLOCKS = 100;
const PING_MS = 1000;
/** Extra ms of margin on top of one-way latency when choosing the input delay. */
const DELAY_MARGIN_MS = 30;
/** Poll gaps longer than this mean we're a throttled background tab, not a slow frame. */
const THROTTLED_GAP_MS = 150;
/** How long a large poll gap keeps the extra send-ahead in effect. */
const GAP_WINDOW_MS = 3000;
/** Never send more than this many blocks beyond the input delay. */
const MAX_LEAD_BLOCKS = 30;

export class LockstepSession implements NetSession {
  readonly events = new Emitter<SessionEvents>();
  readonly setup: MatchSetup;
  readonly matchId: string;
  readonly turnTicks: number;
  localPlayer: PlayerId;

  private readonly transport: Transport;
  private readonly env: NetEnv;
  private readonly start: StartInfo;
  private readonly self: PeerId;
  private readonly players: PlayerId[];
  private readonly humans: Set<PlayerId>;
  private readonly segments = new Map<PlayerId, Segment[]>();
  /** inputs[player][block][peer] = commands */
  private readonly inputs = new Map<PlayerId, Map<number, Map<PeerId, Command[]>>>();
  private appliedBlock = -1;
  private readonly turnLog = new Map<Tick, PlayerCommand[]>();
  private readonly turns: Turn[] = [];
  private lastTurn: Turn | null = null;
  private localBlock = 0;
  /** Next block to send, per player this peer controls. */
  private readonly nextSend = new Map<PlayerId, number>();
  private readonly pending = new Map<PlayerId, Command[]>();
  private readonly pendingCtl: { block: number; change: CtlChange }[] = [];
  private readonly sent = new Map<number, NetMessage>();
  private maxSeen = -1;
  private readonly rtt = new Map<PeerId, PeerRtt>();
  private lastPing = -Infinity;
  /** Latest block each peer reported being at (from pings); the sync's applied block for a rejoiner. */
  private readonly peerBlock = new Map<PeerId, number>();
  private syncHead = -1;
  private lastPollAt: number | null = null;
  private recentGap = 0;
  private recentGapAt = 0;
  private delayBlocks: number;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly drops = new Map<PeerId, DropState>();
  private readonly hashes = new Map<Tick, Map<PeerId, number>>();
  private readonly desyncs = new Set<Tick>();
  private readonly leftAt = new Map<PlayerId, { tick: Tick; at: number }>();
  private readonly rejoinQueue: { peer: PeerId; req: RejoinRequest }[] = [];
  private authorityPeer: PeerId;
  private waitingFor: PlayerId[] = [];
  private waitingSince: number | null = null;
  private phase: SessionStatus['phase'] = 'running';
  private disposed = false;
  private readonly onDispose?: () => void;

  constructor(cfg: LockstepConfig) {
    this.transport = cfg.transport;
    this.env = cfg.env ?? realEnv;
    this.start = cfg.sync?.start ?? cfg.start;
    this.setup = this.start.setup;
    this.matchId = this.start.matchId;
    this.turnTicks = this.start.turnTicks;
    this.self = this.transport.selfId;
    this.players = this.setup.players.map((p) => p.id).sort((a, b) => a - b);
    this.humans = new Set(this.setup.players.filter((p) => p.kind === 'human').map((p) => p.id));
    this.minDelay = cfg.minDelayBlocks ?? 1;
    this.maxDelay = cfg.maxDelayBlocks ?? 8;
    this.delayBlocks = this.minDelay;
    this.onDispose = cfg.onDispose;
    for (const [p, segs] of this.start.segments) this.segments.set(p, segs.map((s) => ({ ...s })));

    const sync = cfg.sync;
    if (sync) {
      this.appliedBlock = sync.appliedBlock;
      for (const turn of sync.turns) {
        this.turnLog.set(turn.tick, turn.commands);
        this.turns.push(turn);
      }
      for (const raw of sync.inputs) this.storeInput(raw[0], raw[1], raw[2], raw[3]);
      this.maxSeen = sync.inputs.reduce((m, raw) => Math.max(m, raw[1]), sync.appliedBlock);
      this.syncHead = sync.appliedBlock;
      for (const [p, tick] of sync.left) this.leftAt.set(p, { tick, at: this.env.now() });
      for (const [tick, h] of sync.hashes) this.hashMap(tick).set('authority', h);
    }

    // Players this peer sends for: every segment of ours, from its first block.
    for (const p of this.players) {
      for (const s of this.segments.get(p) ?? []) {
        if (s.peer === this.self && s.until === null) this.nextSend.set(p, s.from);
      }
    }
    this.localPlayer = sync?.player ?? [...this.nextSend.keys()].find((p) => this.humans.has(p)) ?? this.players[0];
    this.authorityPeer = this.computeAuthority();
  }

  // -------------------------------------------------------------------------------------
  // NetSession
  // -------------------------------------------------------------------------------------

  submit(cmd: Command, player: PlayerId = this.localPlayer): void {
    if (!this.nextSend.has(player)) {
      console.warn(`[net] dropping command for player ${player}: not controlled by this peer`);
      return;
    }
    let list = this.pending.get(player);
    if (!list) this.pending.set(player, (list = []));
    list.push(cmd);
  }

  pollTurn(tick: Tick): Turn | null {
    if (this.disposed) return null;
    this.trackPollGap();
    if (this.lastTurn?.tick === tick) return this.lastTurn;
    this.service();
    const block = Math.floor(tick / this.turnTicks);
    this.localBlock = block;
    this.flush();
    if (block > this.appliedBlock && !this.tryApply(block)) {
      this.updatePhase();
      return null;
    }
    const commands = tick % this.turnTicks === 0 ? (this.turnLog.get(tick) ?? []) : [];
    this.lastTurn = { tick, commands };
    this.updatePhase();
    return this.lastTurn;
  }

  reportHash(tick: Tick, hash: number): void {
    this.hashMap(tick).set(this.self, hash);
    this.transport.send({ t: 'hash', tick, h: hash });
    this.checkHashes(tick);
  }

  /** Leave the match. Others see our player leave; our units go idle. */
  dispose(): void {
    if (this.disposed) return;
    this.transport.send({ t: 'bye' });
    this.disposed = true;
    this.phase = 'closed';
    this.emitStatus();
    this.events.clear();
    this.onDispose?.();
  }

  // -------------------------------------------------------------------------------------
  // Public API beyond NetSession (UI / match integration)
  // -------------------------------------------------------------------------------------

  get status(): SessionStatus {
    const rtt: Partial<Record<PlayerId, number>> = {};
    for (const [peer, r] of this.rtt) {
      const p = this.humanOf(peer);
      if (p !== undefined) rtt[p] = Math.round(r.avg);
    }
    return {
      phase: this.phase,
      waitingFor: this.phase === 'waiting' ? [...this.waitingFor] : [],
      waitingSince: this.phase === 'waiting' ? this.waitingSince : null,
      inputDelayTicks: this.delayBlocks * this.turnTicks,
      rtt,
      authority: this.humanOf(this.authorityPeer) ?? -1,
    };
  }

  /** Transport id of the current authority (host). */
  get authority(): PeerId {
    return this.authorityPeer;
  }

  get isAuthority(): boolean {
    return this.authorityPeer === this.self;
  }

  /** Players this peer currently sends commands for (its human plus any AI it hosts). */
  controlledPlayers(): PlayerId[] {
    return [...this.nextSend.keys()].sort((a, b) => a - b);
  }

  /** True when this peer should run the AI for `player`. */
  controls(player: PlayerId): boolean {
    return this.nextSend.has(player);
  }

  /**
   * How many ticks this peer should step right away: turns it already has (a rejoiner starts
   * with the whole log) or, when it fell behind the others (a throttled background tab, a long
   * hitch), the gap to where they are. The match loop steps without its per-frame cap while
   * this is large; `pollTurn` still returns null whenever input is genuinely missing.
   */
  backlogTicks(currentTick: Tick): number {
    const applied = (this.appliedBlock + 1) * this.turnTicks - currentTick;
    const behind = this.behindBlocks(Math.floor(currentTick / this.turnTicks));
    return Math.max(0, applied, behind > this.catchUpThreshold() ? behind * this.turnTicks : 0);
  }

  /** Every applied turn with commands so far, plus the setup: a replay or a rejoin log. */
  commandLog(): CommandLog {
    return {
      matchId: this.matchId,
      setup: this.setup,
      turnTicks: this.turnTicks,
      endTick: (this.appliedBlock + 1) * this.turnTicks,
      turns: this.turns.map((t) => ({ tick: t.tick, commands: t.commands })),
      hashes: [...this.hashes].flatMap(([tick, m]) => (m.has(this.self) ? [[tick, m.get(this.self)!] as [number, number]] : [])),
    };
  }

  /** Ask the authority to drop a player who is stalling the game (e.g. a frozen tab). */
  dropPlayer(player: PlayerId): void {
    const seg = this.openSegment(player);
    if (seg && seg.peer !== this.self) this.beginDrop(seg.peer);
  }

  /** @internal Called by the lobby for every message. */
  handleMessage(msg: NetMessage, from: PeerId): void {
    if (this.disposed) return;
    switch (msg.t) {
      case 'in':
        return this.onInput(msg, from);
      case 'ping':
        if (msg.blk !== undefined) this.peerBlock.set(from, msg.blk);
        return this.transport.send({ t: 'pong', ts: msg.ts }, from);
      case 'pong':
        return this.onPong(msg.ts, from);
      case 'hash':
        this.hashMap(msg.tick).set(from, msg.h);
        return this.checkHashes(msg.tick);
      case 'bye':
        return this.onPeerGone(from);
      case 'dropBegin':
        if (msg.peer === this.self) return this.onDroppedSelf();
        return this.beginDrop(msg.peer);
      case 'dropReport':
        return this.onDropReport(msg.peer, from, msg.max, msg.inputs);
      case 'dropFinal':
        return this.onDropFinal(msg.peer, msg.last, msg.inputs, msg.reassign);
      default:
    }
  }

  /** @internal */
  handlePeerJoin(peer: PeerId): void {
    if (this.disposed) return;
    // Anything we sent before this link existed never reached it. Inputs are idempotent.
    this.resendRecent(peer);
  }

  /** @internal */
  handlePeerLeave(peer: PeerId): void {
    if (this.disposed) return;
    this.onPeerGone(peer);
  }

  /**
   * @internal A peer asks to take over a player again (page reload / dropped connection).
   * Only the authority acts; the rejoiner retries until whoever is authority answers.
   */
  async handleRejoin(peer: PeerId, req: RejoinRequest): Promise<'accepted' | 'pending' | 'ignored' | 'denied' | 'expired'> {
    if (!this.isAuthority || this.disposed) return 'ignored';
    if (req.matchId !== this.matchId || !this.humans.has(req.player)) return 'denied';
    const expected = this.start.secretHashes.find(([p]) => p === req.player)?.[1];
    if (!expected || (await sha256Hex(req.secret)) !== expected) return 'denied';
    if (!this.isAuthority || this.disposed) return 'ignored';

    const open = this.openSegment(req.player);
    if (open?.peer === peer) return 'accepted'; // duplicate request, already handled
    if (open) {
      // The old connection has not been detected as gone yet; drop it first.
      this.beginDrop(open.peer);
      if (!this.rejoinQueue.some((q) => q.peer === peer)) this.rejoinQueue.push({ peer, req });
      return 'pending';
    }
    const left = this.leftAt.get(req.player);
    if (left && this.env.now() - left.at > this.start.rejoinWindowMs) return 'expired';
    this.acceptRejoin(peer, req.player);
    return 'accepted';
  }

  // -------------------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------------------

  /**
   * Behind = the others' sims are well ahead of ours (rejoining, or a throttled tab). Judged from
   * the blocks peers report, not from how far ahead their input reaches: a peer may legitimately
   * send far ahead (see `leadBlocks`), and that must not make everyone else think they're behind.
   */
  private get catchingUp(): boolean {
    return this.behindBlocks(this.localBlock) > this.catchUpThreshold();
  }

  private catchUpThreshold(): number {
    return 2 * this.delayBlocks + 4;
  }

  private behindBlocks(localBlock: number): number {
    let head = this.syncHead;
    for (const [peer, b] of this.peerBlock) if (this.isActivePeer(peer)) head = Math.max(head, b);
    return head - localBlock;
  }

  private flush(): void {
    if (this.phase === 'dropped' || this.nextSend.size === 0) return;
    let target = this.localBlock + this.delayBlocks + this.leadBlocks();
    // While fast-forwarding after a rejoin, keep pace with the others instead of stalling them.
    if (this.catchingUp) target = Math.max(target, this.maxSeen);
    for (;;) {
      let block = Infinity;
      for (const b of this.nextSend.values()) block = Math.min(block, b);
      if (block > target) break;
      const c: [PlayerId, Command[]][] = [];
      for (const [p, next] of this.nextSend) {
        if (next !== block) continue;
        const cmds = this.pending.get(p) ?? [];
        this.pending.delete(p);
        c.push([p, cmds]);
        this.nextSend.set(p, block + 1);
      }
      const ctl = this.pendingCtl.filter((x) => x.block === block).map((x) => x.change);
      const msg: NetMessage = ctl.length ? { t: 'in', b: block, c, ctl } : { t: 'in', b: block, c };
      for (const [p, cmds] of c) this.storeInput(p, block, this.self, cmds);
      this.sent.set(block, msg);
      this.sent.delete(block - KEEP_BLOCKS);
      this.transport.send(msg);
    }
  }

  /**
   * A background tab only gets ~1 timer per second, so between its frames the others would
   * run out of its input after `delayBlocks` and the whole game would crawl. When polls come
   * in large gaps, send (empty) input far enough ahead to cover the next gap. The cost is
   * extra command latency for the player who isn't looking anyway.
   */
  private trackPollGap(): void {
    const now = this.env.now();
    if (this.lastPollAt !== null) {
      const gap = now - this.lastPollAt;
      if (gap >= this.recentGap || now - this.recentGapAt > GAP_WINDOW_MS) {
        this.recentGap = gap;
        this.recentGapAt = now;
      }
    }
    this.lastPollAt = now;
  }

  private leadBlocks(): number {
    if (this.recentGap < THROTTLED_GAP_MS) return 0;
    return Math.min(MAX_LEAD_BLOCKS, Math.ceil(this.recentGap / (this.turnTicks * TICK_MS)) + 1);
  }

  private resendRecent(peer: PeerId): void {
    const from = Math.max(0, this.appliedBlock - RESEND_BLOCKS);
    for (const [b, msg] of this.sent) if (b >= from) this.transport.send(msg, peer);
  }

  private service(): void {
    const now = this.env.now();
    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      this.transport.send({ t: 'ping', ts: now, blk: this.localBlock });
    }
  }

  private onPong(ts: number, from: PeerId): void {
    const sample = this.env.now() - ts;
    const r = this.rtt.get(from);
    if (!r) this.rtt.set(from, { avg: sample, dev: sample / 2 });
    else {
      r.dev = r.dev * 0.75 + Math.abs(sample - r.avg) * 0.25;
      r.avg = r.avg * 0.875 + sample * 0.125;
    }
    let worst = 0;
    for (const [peer, x] of this.rtt) if (this.isActivePeer(peer)) worst = Math.max(worst, x.avg + 2 * x.dev);
    const blockMs = this.turnTicks * TICK_MS;
    const want = Math.ceil((worst / 2 + DELAY_MARGIN_MS) / blockMs);
    this.delayBlocks = Math.min(this.maxDelay, Math.max(this.minDelay, want));
  }

  // -------------------------------------------------------------------------------------
  // Receiving and applying
  // -------------------------------------------------------------------------------------

  private onInput(msg: Extract<NetMessage, { t: 'in' }>, from: PeerId): void {
    if (this.drops.has(from)) return; // frozen: its last block is being agreed on
    for (const change of msg.ctl ?? []) this.applyCtl(change, msg.b);
    for (const [p, cmds] of msg.c) this.storeInput(p, msg.b, from, cmds);
    if (from !== this.self) this.maxSeen = Math.max(this.maxSeen, msg.b);
  }

  private storeInput(player: PlayerId, block: number, peer: PeerId, cmds: Command[]): void {
    if (block <= this.appliedBlock) return;
    let byBlock = this.inputs.get(player);
    if (!byBlock) this.inputs.set(player, (byBlock = new Map()));
    let byPeer = byBlock.get(block);
    if (!byPeer) byBlock.set(block, (byPeer = new Map()));
    if (!byPeer.has(peer)) byPeer.set(peer, cmds);
  }

  private tryApply(block: number): boolean {
    if (block !== this.appliedBlock + 1) throw new Error(`[net] turn ${block} requested before ${this.appliedBlock + 1}`);
    const missing: PlayerId[] = [];
    const commands: PlayerCommand[] = [];
    for (const p of this.players) {
      const seg = this.segmentAt(p, block);
      if (!seg) continue;
      const cmds = this.inputs.get(p)?.get(block)?.get(seg.peer);
      if (!cmds) missing.push(p);
      else for (const cmd of cmds) commands.push({ player: p, cmd });
    }
    if (missing.length) {
      if (missing.join() !== this.waitingFor.join() || this.waitingSince === null) {
        this.waitingFor = missing;
        this.waitingSince ??= this.env.now();
        this.phase = 'waiting';
        this.emitStatus();
      }
      return false;
    }
    this.appliedBlock = block;
    const tick = block * this.turnTicks;
    if (commands.length) {
      this.turnLog.set(tick, commands);
      this.turns.push({ tick, commands });
    }
    for (const byBlock of this.inputs.values()) {
      byBlock.delete(block - KEEP_BLOCKS);
    }
    this.waitingFor = [];
    this.waitingSince = null;
    return true;
  }

  private updatePhase(): void {
    if (this.phase === 'dropped' || this.phase === 'closed') return;
    let phase: SessionStatus['phase'];
    if (this.waitingSince !== null) phase = 'waiting';
    else if (this.catchingUp) phase = 'catchingUp';
    else phase = 'running';
    if (phase !== this.phase) {
      this.phase = phase;
      this.emitStatus();
    }
  }

  private emitStatus(): void {
    this.events.emit('status', this.status);
  }

  // -------------------------------------------------------------------------------------
  // Control segments, authority
  // -------------------------------------------------------------------------------------

  private segmentAt(p: PlayerId, block: number): Segment | undefined {
    return this.segments.get(p)?.find((s) => s.from <= block && (s.until === null || block <= s.until));
  }

  private openSegment(p: PlayerId): Segment | undefined {
    return this.segments.get(p)?.find((s) => s.until === null);
  }

  private applyCtl(change: CtlChange, block: number): void {
    const segs = this.segments.get(change.player) ?? [];
    this.segments.set(change.player, segs);
    if (segs.some((s) => s.peer === change.peer && s.from === block)) return;
    for (const s of segs) if (s.until === null) s.until = block - 1;
    segs.push({ peer: change.peer, from: block, until: null });
    this.leftAt.delete(change.player);
    if (change.peer !== this.self) this.resendRecent(change.peer);
    this.events.emit('playerRejoined', { player: change.player, tick: block * this.turnTicks });
    this.recomputeAuthority();
  }

  private isActivePeer(peer: PeerId): boolean {
    if (this.drops.has(peer)) return false;
    for (const segs of this.segments.values()) if (segs.some((s) => s.peer === peer && s.until === null)) return true;
    return false;
  }

  private isConnected(peer: PeerId): boolean {
    return peer === this.self || this.transport.peers().includes(peer);
  }

  private humanOf(peer: PeerId): PlayerId | undefined {
    let best: PlayerId | undefined;
    for (const [p, segs] of this.segments) {
      if (!this.humans.has(p)) continue;
      if (segs.some((s) => s.peer === peer) && (best === undefined || p < best)) best = p;
    }
    return best;
  }

  private computeAuthority(): PeerId {
    let best: PeerId = this.self;
    let bestPlayer = Infinity;
    for (const p of this.players) {
      if (!this.humans.has(p)) continue;
      const seg = this.openSegment(p);
      if (!seg || !this.isActivePeer(seg.peer) || !this.isConnected(seg.peer)) continue;
      if (p < bestPlayer) {
        bestPlayer = p;
        best = seg.peer;
      }
    }
    return best;
  }

  private recomputeAuthority(): void {
    const next = this.computeAuthority();
    if (next === this.authorityPeer) return;
    this.authorityPeer = next;
    this.events.emit('authority', { player: this.humanOf(next) ?? -1, isSelf: next === this.self });
    // Reports went to the old authority; send them again.
    for (const [peer, d] of this.drops) {
      d.reportedTo = undefined;
      this.sendDropReport(peer);
    }
    if (this.isAuthority) for (const peer of this.drops.keys()) this.transport.send({ t: 'dropBegin', peer });
    this.emitStatus();
  }

  // -------------------------------------------------------------------------------------
  // Departures
  // -------------------------------------------------------------------------------------

  private onPeerGone(peer: PeerId): void {
    if (this.isActivePeer(peer)) this.beginDrop(peer);
    this.recomputeAuthority();
    for (const d of this.drops.keys()) this.tryFinalize(d);
  }

  private beginDrop(peer: PeerId): void {
    if (peer === this.self || this.drops.has(peer) || !this.isActivePeer(peer)) return;
    this.drops.set(peer, { reports: new Map() });
    this.recomputeAuthority();
    if (this.isAuthority) this.transport.send({ t: 'dropBegin', peer });
    this.sendDropReport(peer);
  }

  /** Highest block b such that we hold `peer`'s inputs for every block up to b. */
  private contiguousMax(peer: PeerId): { max: number; inputs: RawInput[] } {
    const inputs: RawInput[] = [];
    let max = Infinity;
    for (const p of this.players) {
      const seg = this.openSegment(p);
      if (!seg || seg.peer !== peer) continue;
      let b = Math.max(seg.from, this.appliedBlock + 1);
      const byBlock = this.inputs.get(p);
      while (byBlock?.get(b)?.has(peer)) b++;
      max = Math.min(max, b - 1);
      for (const [block, byPeer] of byBlock ?? []) {
        const cmds = byPeer.get(peer);
        if (cmds && block < b) inputs.push([p, block, peer, cmds]);
      }
    }
    return { max: max === Infinity ? this.appliedBlock : max, inputs };
  }

  private sendDropReport(peer: PeerId): void {
    const d = this.drops.get(peer);
    if (!d || d.reportedTo === this.authorityPeer) return;
    d.reportedTo = this.authorityPeer;
    const { max, inputs } = this.contiguousMax(peer);
    if (this.isAuthority) this.onDropReport(peer, this.self, max, inputs);
    else this.transport.send({ t: 'dropReport', peer, max, inputs }, this.authorityPeer);
  }

  private onDropReport(peer: PeerId, from: PeerId, max: number, inputs: RawInput[]): void {
    if (!this.isActivePeer(peer) && !this.drops.has(peer)) return; // already final
    this.beginDrop(peer);
    const d = this.drops.get(peer);
    if (!d) return;
    d.reports.set(from, { max, inputs });
    this.tryFinalize(peer);
  }

  private tryFinalize(peer: PeerId): void {
    const d = this.drops.get(peer);
    if (!d || !this.isAuthority) return;
    const needed = new Set<PeerId>();
    for (const segs of this.segments.values()) {
      for (const s of segs) {
        if (s.until === null && s.peer !== peer && this.isActivePeer(s.peer) && this.isConnected(s.peer)) needed.add(s.peer);
      }
    }
    for (const n of needed) if (!d.reports.has(n)) return;
    let last = this.appliedBlock;
    const union = new Map<string, RawInput>();
    for (const [reporter, r] of d.reports) {
      if (!needed.has(reporter)) continue;
      last = Math.max(last, r.max);
      for (const raw of r.inputs) union.set(`${raw[0]}:${raw[1]}`, raw);
    }
    const inputs = [...union.values()].filter((raw) => raw[1] <= last);
    // AI players move to us; humans are out until they rejoin.
    const reassign: [PlayerId, PeerId][] = [];
    for (const p of this.players) {
      const seg = this.openSegment(p);
      if (seg?.peer === peer && !this.humans.has(p)) reassign.push([p, this.self]);
    }
    const msg: NetMessage = { t: 'dropFinal', peer, last, inputs, reassign };
    this.transport.send(msg);
    this.onDropFinal(peer, last, inputs, reassign);
  }

  private onDropFinal(peer: PeerId, last: number, inputs: RawInput[], reassign: [PlayerId, PeerId][]): void {
    if (!this.drops.has(peer) && !this.isActivePeer(peer)) return;
    this.drops.delete(peer);
    for (const raw of inputs) if (raw[2] === peer) this.storeInput(raw[0], raw[1], raw[2], raw[3]);
    const tick = (last + 1) * this.turnTicks;
    let controlChanged = false;
    for (const p of this.players) {
      const segs = this.segments.get(p);
      const seg = segs?.find((s) => s.until === null && s.peer === peer);
      if (!segs || !seg) continue;
      seg.until = last;
      const to = reassign.find(([rp]) => rp === p)?.[1];
      if (to !== undefined) {
        segs.push({ peer: to, from: last + 1, until: null });
        if (to === this.self) {
          this.nextSend.set(p, last + 1);
          controlChanged = true;
        }
      } else {
        this.leftAt.set(p, { tick, at: this.env.now() });
        this.events.emit('playerLeft', { player: p, tick });
      }
    }
    if (controlChanged) this.events.emit('control', { players: this.controlledPlayers() });
    this.recomputeAuthority();
    this.processRejoinQueue();
  }

  private onDroppedSelf(): void {
    if (this.phase === 'dropped') return;
    this.phase = 'dropped';
    this.nextSend.clear();
    this.emitStatus();
    this.events.emit('dropped', {});
  }

  // -------------------------------------------------------------------------------------
  // Rejoin
  // -------------------------------------------------------------------------------------

  private processRejoinQueue(): void {
    const queue = this.rejoinQueue.splice(0);
    for (const { peer, req } of queue) void this.handleRejoin(peer, req);
  }

  private acceptRejoin(peer: PeerId, player: PlayerId): void {
    const segs = this.segments.get(player) ?? [];
    const lastUntil = segs.reduce((m, s) => Math.max(m, s.until ?? m), -1);
    const myNext = this.nextSend.get(this.localPlayer) ?? this.appliedBlock + 1;
    const resumeBlock = Math.max(myNext, lastUntil + 1, this.appliedBlock + 1);
    // Record locally now; everyone else learns it with our input for `resumeBlock`.
    this.applyCtl({ player, peer }, resumeBlock);
    this.pendingCtl.push({ block: resumeBlock, change: { player, peer } });

    const inputs: RawInput[] = [];
    for (const [p, byBlock] of this.inputs) {
      for (const [b, byPeer] of byBlock) {
        if (b <= this.appliedBlock) continue;
        for (const [from, cmds] of byPeer) inputs.push([p, b, from, cmds]);
      }
    }
    const hashes: [number, number][] = [];
    for (const [tick, m] of this.hashes) {
      const h = m.get(this.self);
      if (h !== undefined) hashes.push([tick, h]);
    }
    const sync: SyncPayload = {
      start: { ...this.start, segments: [...this.segments].map(([p, s]) => [p, s.map((x) => ({ ...x }))]) },
      player,
      resumeBlock,
      appliedBlock: this.appliedBlock,
      turns: this.turns,
      inputs,
      hashes,
      left: [...this.leftAt].filter(([p]) => p !== player).map(([p, l]) => [p, l.tick]),
    };
    this.transport.send({ t: 'sync', sync }, peer);
  }

  // -------------------------------------------------------------------------------------
  // Desync detection
  // -------------------------------------------------------------------------------------

  private hashMap(tick: Tick): Map<PeerId, number> {
    let m = this.hashes.get(tick);
    if (!m) this.hashes.set(tick, (m = new Map()));
    return m;
  }

  private checkHashes(tick: Tick): void {
    const m = this.hashes.get(tick);
    if (!m || m.size < 2 || this.desyncs.has(tick)) return;
    const values = new Set(m.values());
    if (values.size < 2) return;
    this.desyncs.add(tick);
    const hashes: Partial<Record<PlayerId, number>> = {};
    for (const [peer, h] of m) {
      const p = peer === 'authority' ? this.humanOf(this.authorityPeer) : this.humanOf(peer);
      hashes[p ?? -1] = h;
    }
    console.error(`[net] desync at tick ${tick}`, hashes);
    this.events.emit('desync', { tick, hashes });
  }
}
