import type { MatchSetup, PlayerId, PlayerSlot } from '../shared/types';
import { COMMAND_ROLES, MAX_PLAYERS } from '../shared/types';
import { Emitter } from './emitter';
import { randomHex, randomU32, realEnv, sha256Hex, type NetEnv } from './env';
import { LockstepSession } from './lockstep';
import {
  MATCH_MESSAGES,
  PROTOCOL_VERSION,
  type AiDifficulty,
  type ChatMessage,
  type LobbySettings,
  type LobbySlot,
  type LobbyState,
  type NetMessage,
  type PeerId,
  type RejectReason,
  type SlotPatch,
  type StartInfo,
  type SyncPayload,
} from './protocol';
import { NetError, type Transport, type TransportFactory } from './transport';
import { trysteroTransport } from './trystero';

/*
 * Lobby API for the UI workstream. No DOM here: screens subscribe to events and call methods.
 *
 *   const lobby = await hostLobby({ name: 'Alice' });          // or joinLobby(code, { name })
 *   lobby.code; lobby.url;                                     // "K7QX2M", ".../#room=K7QX2M"
 *   lobby.on('change', (state) => render(state));              // slots, settings, host
 *   lobby.on('chat', (msg) => appendChat(msg));
 *   lobby.on('start', ({ setup, session }) => new Match(setup, content, session, ...));
 *   lobby.on('closed', (err) => showError(err.message));       // kicked, host gone, network
 *   lobby.setReady(true); lobby.sendChat('gl hf');
 *   if (lobby.isHost && lobby.canStart().ok) await lobby.start();
 *
 * After a page reload during a match, `joinLobby(code, ...)` finds the rejoin ticket in
 * sessionStorage and resolves with `lobby.match` already set (session fast-forwarding).
 * Check `lobby.match` right after joining, since its 'start' event fired before you subscribed.
 */

export const ROOM_CODE_LENGTH = 6;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Default player colors in slot order. */
export const PLAYER_COLORS = ['#4f8fe6', '#d9503f', '#4fbf5a', '#e0b23a', '#9b5fd6', '#3fc6c6', '#e07a2f', '#d65f9b'];
const TICKET_KEY = 'frontline.rejoin';
const DEFAULT_TURN_TICKS = 2;
const DEFAULT_REJOIN_WINDOW_MS = 5 * 60_000;
const HELLO_RETRY_MS = 2500;
const LOBBY_PING_MS = 2000;
const MAX_NAME = 24;
const MAX_CHAT = 300;

export interface LobbyOptions {
  /** Display name, trimmed to 24 chars. */
  name: string;
  /** Defaults to Trystero (Nostr + MQTT, torrent fallback). Tests pass a LoopbackNetwork factory. */
  transport?: TransportFactory;
  env?: NetEnv;
  /** Base of the share link; defaults to the current page without its hash. */
  baseUrl?: string;
  /** joinLobby only: fail with `host-unreachable` after this long. Default 20 s. */
  joinTimeoutMs?: number;
  /** joinLobby only: ticket to retake a player in a running match. Defaults to the stored one for this code; false disables. */
  rejoin?: RejoinTicket | false;
  /** hostLobby only: initial settings. */
  settings?: Partial<LobbySettings>;
  /** Where rejoin tickets are kept. Defaults to sessionStorage (per tab, survives reload). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** How long a dropped player may rejoin. Host only. Default 5 min. */
  rejoinWindowMs?: number;
}

/** Proof that this tab played `player` in match `matchId`. Kept in sessionStorage. */
export interface RejoinTicket {
  code: string;
  matchId: string;
  player: PlayerId;
  secret: string;
}

export interface StartedMatch {
  setup: MatchSetup;
  session: LockstepSession;
  /** True when this peer rejoined a running match and is fast-forwarding. */
  rejoined: boolean;
}

export interface LobbyEvents {
  /** Any change to slots, settings, host or phase. */
  change: LobbyState;
  chat: ChatMessage;
  /** The match starts (or was rejoined). Same setup on every peer. */
  start: StartedMatch;
  hostChanged: { hostPeer: PeerId; isSelf: boolean };
  /** The lobby is over for this peer: kicked, rejected, network failure, or `leave()`. */
  closed: NetError;
}

export interface StartCheck {
  ok: boolean;
  reason?: 'not-host' | 'not-enough-players' | 'one-team' | 'not-ready' | 'started';
}

/** Generate a 6-char room code without look-alike characters (no 0/O, 1/I). */
export function makeRoomCode(env: NetEnv = realEnv): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(env.random() * CODE_ALPHABET.length)];
  return code;
}

/** Upper-cases and strips a typed code; returns null if it can't be a room code. */
export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Room code from a share link or `location.hash` (`#room=CODE`), else null. */
export function roomCodeFromUrl(url: string = typeof location !== 'undefined' ? location.href : ''): string | null {
  const m = /[#&?]room=([A-Za-z0-9]+)/.exec(url);
  return m ? normalizeRoomCode(m[1]) : null;
}

export function shareUrl(code: string, baseUrl?: string): string {
  const base = baseUrl ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '');
  return `${base}#room=${code}`;
}

/** Create a lobby and become its host. Rejects with `NetError` if signaling is unavailable. */
export async function hostLobby(opts: LobbyOptions): Promise<Lobby> {
  const env = opts.env ?? realEnv;
  const code = makeRoomCode(env);
  const transport = await (opts.transport ?? trysteroTransport())(code, env);
  const lobby = new Lobby(transport, code, env, opts);
  await lobby.initSecret();
  lobby.initAsHost();
  return lobby;
}

/**
 * Join a lobby by code. Resolves once the host has accepted us (or a rejoin sync arrived).
 * Rejects with `NetError`: `signaling-unavailable`, `host-unreachable`, `rejected` (`reason`
 * is a RejectReason: full / in-progress / version / kicked / rejoin-denied / rejoin-expired).
 */
export async function joinLobby(code: string, opts: LobbyOptions): Promise<Lobby> {
  const norm = normalizeRoomCode(code);
  if (!norm) throw new NetError('host-unreachable', 'invalid room code');
  const env = opts.env ?? realEnv;
  const transport = await (opts.transport ?? trysteroTransport())(norm, env);
  const lobby = new Lobby(transport, norm, env, opts);
  await lobby.initSecret();
  return lobby.joinAsClient(opts.joinTimeoutMs ?? 20_000);
}

export class Lobby {
  readonly events = new Emitter<LobbyEvents>();
  readonly code: string;
  readonly url: string;
  readonly selfId: PeerId;
  /** Set once the match started (also right away after a rejoin). */
  match: StartedMatch | null = null;

  private state: LobbyState;
  private readonly name: string;
  private secret = '';
  private secretHash = '';
  private readonly banned = new Set<string>();
  private readonly buffered: [NetMessage, PeerId][] = [];
  private session: LockstepSession | null = null;
  private closed = false;
  private readonly storage: LobbyOptions['storage'];
  private joinResolve?: (l: Lobby) => void;
  private joinReject?: (e: NetError) => void;
  private helloTimer: unknown;
  private rejoinTicket: RejoinTicket | null = null;
  private pingTimer: unknown;

  /** @internal Use hostLobby / joinLobby. */
  constructor(
    private readonly transport: Transport,
    code: string,
    private readonly env: NetEnv,
    private readonly opts: LobbyOptions,
  ) {
    this.code = code;
    this.url = shareUrl(code, opts.baseUrl);
    this.selfId = transport.selfId;
    this.name = cleanName(opts.name);
    this.storage = opts.storage !== undefined ? opts.storage : typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    this.state = {
      code,
      hostPeer: '',
      phase: 'lobby',
      settings: { mapId: 'sandbox', victory: 'frontline', maxPlayers: MAX_PLAYERS, ...opts.settings },
      slots: [],
    };
    transport.events.on('message', ({ msg, from }) => this.onMessage(msg, from));
    transport.events.on('peerJoin', (peer) => this.onPeerJoin(peer));
    transport.events.on('peerLeave', (peer) => this.onPeerLeave(peer));
    transport.events.on('status', (s) => {
      if (s.state === 'failed') this.close(new NetError(s.error ?? 'signaling-unavailable'));
    });
    this.pingLoop();
  }

  // -------------------------------------------------------------------------------------
  // Reading state
  // -------------------------------------------------------------------------------------

  /** Shorthand for `lobby.events.on`. */
  on<K extends keyof LobbyEvents>(type: K, fn: (e: LobbyEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  /** Current snapshot. Treat as read-only; it is replaced on every change. */
  get snapshot(): LobbyState {
    return this.state;
  }

  get isHost(): boolean {
    return this.state.hostPeer === this.selfId;
  }

  get slots(): LobbySlot[] {
    return this.state.slots.filter((s) => s.index < this.state.settings.maxPlayers);
  }

  get settings(): LobbySettings {
    return this.state.settings;
  }

  /** Our own slot, if we have one. */
  get localSlot(): LobbySlot | undefined {
    return this.state.slots.find((s) => s.peer === this.selfId);
  }

  /** Connected peer count, for a "connecting…" indicator. */
  get peerCount(): number {
    return this.transport.peers().length;
  }

  get transportStatus(): Transport['status'] {
    return this.transport.status;
  }

  // -------------------------------------------------------------------------------------
  // Actions for every player
  // -------------------------------------------------------------------------------------

  /** Change our own name / team / color / faction / ready flag. */
  updateSelf(patch: SlotPatch): void {
    if (this.isHost) this.applySlotPatch(this.selfId, patch);
    else this.toHost({ t: 'slotReq', patch });
  }

  setReady(ready: boolean): void {
    this.updateSelf({ ready });
  }

  /** Move to another open slot (keeps name, team, color; clears ready). */
  moveToSlot(index: number): void {
    if (this.isHost) this.applyMove(this.selfId, index);
    else this.toHost({ t: 'moveReq', index });
  }

  sendChat(text: string): void {
    const clean = text.trim().slice(0, MAX_CHAT);
    if (!clean) return;
    if (this.isHost) this.hostChat(this.selfId, clean);
    else this.toHost({ t: 'chat', text: clean });
  }

  /** Leave the lobby or the match. Clears the rejoin ticket. */
  leave(): void {
    this.storage?.removeItem(TICKET_KEY);
    this.close(new NetError('closed'));
  }

  // -------------------------------------------------------------------------------------
  // Host-only actions (ignored for non-hosts)
  // -------------------------------------------------------------------------------------

  /**
   * Map, victory mode, max players (the map's spawn count). Changing settings clears everyone's ready
   * flag. Shrinking moves seated players and AIs down into free slots and closes the rest; it's refused
   * (returns false, nothing changes) when more are seated than the new size holds.
   */
  setSettings(patch: Partial<LobbySettings>): boolean {
    if (!this.isHost || this.state.phase !== 'lobby') return false;
    const s = { ...this.state.settings, ...patch };
    s.maxPlayers = clampInt(s.maxPlayers, 2, MAX_PLAYERS);
    const old = this.state.settings.maxPlayers;
    const seated = this.state.slots.filter((x) => x.state === 'human' || x.state === 'ai');
    if (seated.length > s.maxPlayers) return false;
    let slots = this.state.slots.map((x) => (x.state === 'human' ? { ...x, ready: x.peer === this.state.hostPeer } : x));
    // Slots that were outside the old size open up; the host's own closed slots stay closed.
    for (let i = old; i < s.maxPlayers; i++) if (slots[i].state === 'closed') slots[i] = emptySlot(i, 'open');
    for (const x of seated) {
      if (x.index < s.maxPlayers) continue;
      let to = slots.findIndex((y, i) => i < s.maxPlayers && y.state === 'open');
      if (to < 0) to = slots.findIndex((y, i) => i < s.maxPlayers && y.state === 'closed');
      slots[to] = { ...slots[x.index], index: to };
      slots[x.index] = emptySlot(x.index, 'closed');
    }
    slots = slots.map((x) => (x.index >= s.maxPlayers && x.state === 'open' ? emptySlot(x.index, 'closed') : x));
    this.state = { ...this.state, settings: s, slots };
    this.broadcastState();
    return true;
  }

  /** Put an AI in `index` (or the first open slot). Returns the slot index or -1. */
  addAi(difficulty: AiDifficulty = 'normal', index?: number): number {
    if (!this.isHost || this.state.phase !== 'lobby') return -1;
    const slot = index !== undefined ? this.state.slots[index] : this.slots.find((s) => s.state === 'open');
    if (!slot || slot.index >= this.state.settings.maxPlayers || slot.state === 'human') return -1;
    this.replaceSlot({
      ...slot,
      state: 'ai',
      peer: undefined,
      secretHash: undefined,
      name: `AI (${difficulty})`,
      ready: true,
      aiDifficulty: difficulty,
      color: this.freeColor(slot.index),
    });
    return slot.index;
  }

  /** Edit any non-human slot (AI team / color / difficulty). */
  setAiSlot(index: number, patch: SlotPatch & { aiDifficulty?: AiDifficulty }): void {
    const slot = this.state.slots[index];
    if (!this.isHost || slot?.state !== 'ai') return;
    const { role: _role, ...clean } = sanitizePatch(patch);
    const next: LobbySlot = { ...slot, ...clean };
    if (patch.aiDifficulty) {
      next.aiDifficulty = patch.aiDifficulty;
      next.name = patch.name ? next.name : `AI (${patch.aiDifficulty})`;
    }
    next.ready = true;
    this.replaceSlot(next);
  }

  /** Host: change another human's team / color / faction (not their name or ready flag). */
  setPlayerSlot(index: number, patch: Pick<SlotPatch, 'team' | 'color' | 'faction' | 'role'>): void {
    const slot = this.state.slots[index];
    if (!this.isHost || slot?.state !== 'human' || !slot.peer) return;
    this.applySlotPatch(slot.peer, { team: patch.team, color: patch.color, faction: patch.faction, role: patch.role });
  }

  /** Open or close an empty / AI slot. */
  setSlotOpen(index: number, open: boolean): void {
    const slot = this.state.slots[index];
    if (!this.isHost || !slot || slot.state === 'human' || this.state.phase !== 'lobby') return;
    this.replaceSlot(emptySlot(index, open ? 'open' : 'closed'));
  }

  /** Remove a player. Humans are told they were kicked and can't come back this lobby. */
  kick(index: number): void {
    const slot = this.state.slots[index];
    if (!this.isHost || !slot || slot.peer === this.selfId) return;
    if (slot.state === 'human' && slot.peer) {
      if (slot.secretHash) this.banned.add(slot.secretHash);
      this.transport.send({ t: 'kicked' }, slot.peer);
    }
    if (slot.state === 'human' || slot.state === 'ai') this.replaceSlot(emptySlot(index, 'open'));
  }

  canStart(): StartCheck {
    if (this.state.phase !== 'lobby') return { ok: false, reason: 'started' };
    if (!this.isHost) return { ok: false, reason: 'not-host' };
    const filled = this.slots.filter((s) => s.state === 'human' || s.state === 'ai');
    if (filled.length < 2) return { ok: false, reason: 'not-enough-players' };
    if (new Set(filled.map((s) => s.team)).size < 2) return { ok: false, reason: 'one-team' };
    if (filled.some((s) => s.state === 'human' && s.peer !== this.selfId && !s.ready)) return { ok: false, reason: 'not-ready' };
    return { ok: true };
  }

  /**
   * Host: start the match. Every peer (us included) gets the same MatchSetup and seed via the
   * 'start' event; this also resolves with ours. Player ids are assigned in slot order.
   */
  async start(): Promise<StartedMatch> {
    const check = this.canStart();
    if (!check.ok) throw new Error(`Cannot start: ${check.reason}`);
    const filled = this.slots.filter((s) => s.state === 'human' || s.state === 'ai');
    const coop = !!this.state.settings.coop;
    let players: PlayerSlot[] = filled.map((s, id) => ({
      id,
      team: s.team,
      name: s.name,
      color: s.color,
      kind: s.state === 'ai' ? 'ai' : 'human',
      ...(s.state === 'ai' ? { aiDifficulty: s.aiDifficulty ?? 'normal' } : {}),
      ...(coop && s.state === 'human' && s.role ? { role: s.role } : {}),
    }));
    if (coop) players = applySharedCommand(players);
    const setup: MatchSetup = {
      seed: randomU32(this.env),
      mapId: this.state.settings.mapId,
      victory: this.state.settings.victory,
      players,
    };
    const start: StartInfo = {
      matchId: randomHex(this.env, 8),
      setup,
      turnTicks: DEFAULT_TURN_TICKS,
      segments: filled.map((s, id) => [id, [{ peer: s.state === 'human' ? s.peer! : this.selfId, from: 0, until: null }]]),
      secretHashes: filled.flatMap((s, id) => (s.state === 'human' && s.secretHash ? [[id, s.secretHash] as [PlayerId, string]] : [])),
      rejoinWindowMs: this.opts.rejoinWindowMs ?? DEFAULT_REJOIN_WINDOW_MS,
    };
    this.transport.send({ t: 'start', start });
    this.onStart(start);
    return this.match!;
  }

  // -------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------

  /** @internal */
  async initSecret(): Promise<void> {
    this.secret = randomHex(this.env, 16);
    this.secretHash = await sha256Hex(this.secret);
  }

  /** @internal */
  initAsHost(): void {
    const slots: LobbySlot[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) slots.push(emptySlot(i, i < this.state.settings.maxPlayers ? 'open' : 'closed'));
    slots[0] = this.humanSlot(0, this.selfId, this.name, this.secretHash, slots);
    slots[0].ready = true;
    this.state = { ...this.state, hostPeer: this.selfId, slots };
    this.events.emit('change', this.state);
  }

  /** @internal */
  joinAsClient(timeoutMs: number): Promise<Lobby> {
    this.rejoinTicket = this.opts.rejoin === false ? null : (this.opts.rejoin ?? this.loadTicket());
    return new Promise<Lobby>((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      const timeout = this.env.setTimeout(() => {
        this.close(new NetError('host-unreachable'));
      }, timeoutMs);
      const done = () => this.env.clearTimeout(timeout);
      this.joinResolve = (l) => {
        done();
        resolve(l);
      };
      this.joinReject = (e) => {
        done();
        reject(e);
      };
      const retry = () => {
        if (this.closed || !this.joinResolve) return;
        this.sendHello();
        this.helloTimer = this.env.setTimeout(retry, HELLO_RETRY_MS);
      };
      retry();
    });
  }

  private sendHello(to?: PeerId): void {
    const t = this.rejoinTicket;
    const msg: NetMessage = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      name: this.name,
      secretHash: this.secretHash,
      ...(t ? { rejoin: { matchId: t.matchId, player: t.player, secret: t.secret } } : {}),
    };
    this.transport.send(msg, to);
  }

  private joined(): void {
    const resolve = this.joinResolve;
    this.joinResolve = undefined;
    this.joinReject = undefined;
    this.env.clearTimeout(this.helloTimer);
    resolve?.(this);
  }

  private onPeerJoin(peer: PeerId): void {
    if (this.joinResolve) this.sendHello(peer);
    this.session?.handlePeerJoin(peer);
  }

  private onPeerLeave(peer: PeerId): void {
    if (this.session) {
      this.session.handlePeerLeave(peer);
      return;
    }
    if (this.state.phase !== 'lobby' || this.joinResolve) return;
    if (peer === this.state.hostPeer) this.migrateHost();
    else if (this.isHost) {
      const slot = this.state.slots.find((s) => s.peer === peer);
      if (slot) {
        this.replaceSlot(emptySlot(slot.index, 'open'));
        this.systemChat(`${slot.name} left`);
      }
    }
  }

  /** Lobby-phase host migration: the human in the lowest slot takes over. */
  private migrateHost(): void {
    const old = this.state.hostPeer;
    const peers = new Set(this.transport.peers());
    // Pings were measured from the old host; the new one re-measures.
    const slots = this.state.slots.map((s) => (s.peer === old ? emptySlot(s.index, 'open') : { ...s, pingMs: undefined }));
    const next = slots.find((s) => s.state === 'human' && s.peer && (s.peer === this.selfId || peers.has(s.peer)));
    if (!next?.peer) return this.close(new NetError('host-unreachable', 'host left'));
    this.state = { ...this.state, slots, hostPeer: next.peer };
    this.events.emit('hostChanged', { hostPeer: next.peer, isSelf: next.peer === this.selfId });
    if (this.isHost) {
      this.state.slots[next.index] = { ...this.state.slots[next.index], ready: true };
      this.broadcastState();
      this.systemChat('Host left; you are the new host');
    } else this.events.emit('change', this.state);
  }

  private onMessage(msg: NetMessage, from: PeerId): void {
    if (this.closed) return;
    if (MATCH_MESSAGES.has(msg.t)) {
      if (this.session) this.session.handleMessage(msg, from);
      else if (this.buffered.length < 10_000) this.buffered.push([msg, from]);
      return;
    }
    switch (msg.t) {
      case 'hello':
        return void this.onHello(msg, from);
      case 'welcome':
      case 'lobby':
        if (msg.state.hostPeer !== from) return;
        if (this.state.phase === 'inGame') return;
        this.state = msg.state;
        this.events.emit('change', this.state);
        if (this.joinResolve && msg.state.slots.some((s) => s.peer === this.selfId)) this.joined();
        return;
      case 'reject':
        if (!this.joinResolve) return;
        // Only the host / authority sends rejects.
        return this.close(new NetError('rejected', msg.reason));
      case 'slotReq':
        if (this.isHost) this.applySlotPatch(from, msg.patch);
        return;
      case 'moveReq':
        if (this.isHost) this.applyMove(from, msg.index);
        return;
      case 'lping':
        return this.transport.send({ t: 'lpong', ts: msg.ts }, from);
      case 'lpong':
        return this.onLobbyPong(from, msg.ts);
      case 'chat':
        if (this.isHost) this.hostChat(from, msg.text);
        return;
      case 'chatMsg':
        if (from === this.state.hostPeer) this.events.emit('chat', msg.msg);
        return;
      case 'kicked':
        if (from === this.state.hostPeer) {
          this.storage?.removeItem(TICKET_KEY);
          this.close(new NetError('kicked'));
        }
        return;
      case 'start':
        if (from === this.state.hostPeer && this.state.phase === 'lobby' && !this.joinResolve) this.onStart(msg.start);
        return;
      case 'sync':
        if (this.joinResolve && this.rejoinTicket && msg.sync.start.matchId === this.rejoinTicket.matchId) this.onSync(msg.sync);
        return;
      default:
    }
  }

  private async onHello(msg: Extract<NetMessage, { t: 'hello' }>, from: PeerId): Promise<void> {
    if (this.state.phase === 'inGame') {
      if (!this.session) return;
      if (msg.rejoin) {
        const result = await this.session.handleRejoin(from, msg.rejoin);
        if (result === 'denied') this.transport.send({ t: 'reject', reason: 'rejoin-denied' }, from);
        else if (result === 'expired') this.transport.send({ t: 'reject', reason: 'rejoin-expired' }, from);
      } else if (this.session.isAuthority) this.transport.send({ t: 'reject', reason: 'in-progress' }, from);
      return;
    }
    if (!this.isHost) return;
    const reject = (reason: RejectReason) => this.transport.send({ t: 'reject', reason }, from);
    if (msg.v !== PROTOCOL_VERSION) return reject('version');
    if (this.banned.has(msg.secretHash)) return reject('kicked');
    const existing = this.state.slots.find((s) => s.peer === from);
    if (existing) {
      this.transport.send({ t: 'welcome', state: this.state }, from);
      return;
    }
    const open = this.slots.find((s) => s.state === 'open');
    if (!open) return reject('full');
    const slot = this.humanSlot(open.index, from, cleanName(msg.name), msg.secretHash, this.state.slots);
    this.replaceSlot(slot);
    this.transport.send({ t: 'welcome', state: this.state }, from);
    this.systemChat(`${slot.name} joined`);
  }

  private humanSlot(index: number, peer: PeerId, name: string, secretHash: string, slots: LobbySlot[]): LobbySlot {
    return {
      index,
      state: 'human',
      peer,
      secretHash,
      name: name || `Player ${index + 1}`,
      team: index,
      color: this.freeColor(index, slots),
      faction: 'default',
      ready: false,
    };
  }

  private freeColor(index: number, slots = this.state.slots): string {
    const used = new Set(slots.filter((s) => s.index !== index && (s.state === 'human' || s.state === 'ai')).map((s) => s.color));
    return [PLAYER_COLORS[index], ...PLAYER_COLORS].find((c) => !used.has(c)) ?? PLAYER_COLORS[index];
  }

  private applyMove(peer: PeerId, index: number): void {
    if (this.state.phase !== 'lobby') return;
    const from = this.state.slots.find((s) => s.peer === peer);
    const to = this.state.slots[index];
    if (!from || !to || to.state !== 'open' || index >= this.state.settings.maxPlayers) return;
    const slots = this.state.slots.slice();
    slots[index] = { ...from, index, ready: peer === this.state.hostPeer };
    slots[from.index] = emptySlot(from.index, 'open');
    this.state = { ...this.state, slots };
    this.broadcastState();
  }

  /** Host pings every peer in the lobby and publishes the RTTs in the slots. */
  private pingLoop(): void {
    if (this.closed || this.state.phase !== 'lobby') return;
    if (this.isHost && this.transport.peers().length) this.transport.send({ t: 'lping', ts: this.env.now() });
    this.pingTimer = this.env.setTimeout(() => this.pingLoop(), LOBBY_PING_MS);
  }

  private onLobbyPong(peer: PeerId, ts: number): void {
    if (!this.isHost || this.state.phase !== 'lobby') return;
    const slot = this.state.slots.find((s) => s.peer === peer);
    if (!slot) return;
    const sample = Math.max(0, Math.round(this.env.now() - ts));
    const pingMs = slot.pingMs === undefined ? sample : Math.round(slot.pingMs * 0.7 + sample * 0.3);
    // Skip tiny changes so pings don't flood every peer with state updates.
    if (slot.pingMs !== undefined && Math.abs(pingMs - slot.pingMs) < 3) return;
    this.replaceSlot({ ...slot, pingMs });
  }

  private applySlotPatch(peer: PeerId, patch: SlotPatch): void {
    if (this.state.phase !== 'lobby') return;
    const slot = this.state.slots.find((s) => s.peer === peer);
    if (!slot) return;
    const clean = sanitizePatch(patch);
    if (clean.color && this.state.slots.some((s) => s.index !== slot.index && s.state !== 'open' && s.state !== 'closed' && s.color === clean.color)) {
      delete clean.color; // taken
    }
    const { role, ...rest } = clean;
    const next: LobbySlot = { ...slot, ...rest };
    if (role === '') delete next.role;
    else if (role) next.role = role;
    if (peer === this.state.hostPeer) next.ready = true;
    this.replaceSlot(next);
  }

  private hostChat(peer: PeerId, text: string): void {
    const slot = this.state.slots.find((s) => s.peer === peer);
    if (!slot) return;
    const msg: ChatMessage = { slot: slot.index, name: slot.name, text: text.trim().slice(0, MAX_CHAT) };
    if (!msg.text) return;
    this.transport.send({ t: 'chatMsg', msg });
    this.events.emit('chat', msg);
  }

  private systemChat(text: string): void {
    const msg: ChatMessage = { slot: -1, name: '', text };
    this.transport.send({ t: 'chatMsg', msg });
    this.events.emit('chat', msg);
  }

  private replaceSlot(slot: LobbySlot): void {
    const slots = this.state.slots.slice();
    slots[slot.index] = slot;
    this.state = { ...this.state, slots };
    this.broadcastState();
  }

  private broadcastState(): void {
    this.transport.send({ t: 'lobby', state: this.state });
    this.events.emit('change', this.state);
  }

  private toHost(msg: NetMessage): void {
    if (this.state.hostPeer) this.transport.send(msg, this.state.hostPeer);
  }

  private onStart(start: StartInfo): void {
    const me = start.segments.find(([p, segs]) => segs.some((s) => s.peer === this.selfId) && start.setup.players[p]?.kind === 'human');
    if (me) this.saveTicket({ code: this.code, matchId: start.matchId, player: me[0], secret: this.secret });
    this.beginMatch(start, undefined);
  }

  private onSync(sync: SyncPayload): void {
    this.saveTicket({ code: this.code, matchId: sync.start.matchId, player: sync.player, secret: this.rejoinTicket!.secret });
    this.beginMatch(sync.start, sync);
    this.joined();
  }

  private beginMatch(start: StartInfo, sync: SyncPayload | undefined): void {
    this.state = { ...this.state, phase: 'inGame' };
    const session = new LockstepSession({
      transport: this.transport,
      start,
      sync,
      env: this.env,
      onDispose: () => this.close(new NetError('closed')),
    });
    this.session = session;
    session.events.on('authority', () => {
      const hostPeer = session.authority;
      this.state = { ...this.state, hostPeer };
      this.events.emit('hostChanged', { hostPeer, isSelf: session.isAuthority });
    });
    for (const peer of this.transport.peers()) session.handlePeerJoin(peer);
    for (const [msg, from] of this.buffered.splice(0)) session.handleMessage(msg, from);
    this.match = { setup: start.setup, session, rejoined: !!sync };
    this.events.emit('change', this.state);
    this.events.emit('start', this.match);
  }

  private saveTicket(t: RejoinTicket): void {
    this.rejoinTicket = t;
    try {
      this.storage?.setItem(TICKET_KEY, JSON.stringify(t));
    } catch {
      // Storage full or blocked: rejoin just won't be automatic.
    }
  }

  private loadTicket(): RejoinTicket | null {
    try {
      const raw = this.storage?.getItem(TICKET_KEY);
      const t = raw ? (JSON.parse(raw) as RejoinTicket) : null;
      return t && t.code === this.code ? t : null;
    } catch {
      return null;
    }
  }

  /** The ticket for the current match (also kept in sessionStorage). */
  get ticket(): RejoinTicket | null {
    return this.rejoinTicket;
  }

  private close(err: NetError): void {
    if (this.closed) return;
    this.closed = true;
    this.env.clearTimeout(this.helloTimer);
    this.env.clearTimeout(this.pingTimer);
    const session = this.session;
    this.session = null;
    session?.dispose();
    this.transport.close();
    if (this.joinReject) {
      this.joinReject(err);
      this.joinResolve = undefined;
      this.joinReject = undefined;
    }
    this.events.emit('closed', err);
    this.events.clear();
  }
}

function emptySlot(index: number, state: 'open' | 'closed'): LobbySlot {
  return { index, state, name: '', team: index, color: PLAYER_COLORS[index], faction: 'default', ready: false };
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
}

function sanitizePatch(patch: SlotPatch): SlotPatch {
  const out: SlotPatch = {};
  if (typeof patch.name === 'string' && cleanName(patch.name)) out.name = cleanName(patch.name);
  if (typeof patch.team === 'number') out.team = clampInt(patch.team, 0, MAX_PLAYERS - 1);
  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) out.color = patch.color.toLowerCase();
  if (typeof patch.faction === 'string' && patch.faction.length <= 24) out.faction = patch.faction;
  if (typeof patch.ready === 'boolean') out.ready = patch.ready;
  if (patch.role === '' || (typeof patch.role === 'string' && (COMMAND_ROLES as readonly string[]).includes(patch.role))) out.role = patch.role;
  return out;
}

/**
 * Shared command: the first human on each team leads the team's army; every other human on that
 * team joins it (`army`) and keeps their role. AIs always lead their own army.
 */
export function applySharedCommand(players: PlayerSlot[]): PlayerSlot[] {
  const leader = new Map<number, PlayerId>();
  return players.map((p) => {
    if (p.kind !== 'human') return p;
    const lead = leader.get(p.team);
    if (lead === undefined) {
      leader.set(p.team, p.id);
      return p;
    }
    return { ...p, army: lead };
  });
}
