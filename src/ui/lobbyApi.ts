import type { MapDef } from '../shared/data';
import type { CommandRole, MatchSetup, PlayerSlot, TeamId, VictoryMode } from '../shared/types';
import { MAX_PLAYERS } from '../shared/types';

/** What a slot edit may change. `role: ''` clears the co-op role. */
export interface SlotPatchUi {
  team?: TeamId;
  color?: string;
  ready?: boolean;
  role?: CommandRole | '';
}

/**
 * What the lobby screen needs from a P2P room. The networking workstream's `src/net/lobby.ts`
 * gets adapted to this by the master session; `FakeLobbyConnector` and `createSkirmishLobby`
 * below let the screens run standalone.
 *
 * Model: a room has up to 8 slots. The host owns map/victory/slot occupancy and starts the match;
 * every peer edits its own team/color/ready. State changes arrive as whole snapshots.
 */

export type MatchMode = 'online' | 'skirmish' | 'tutorial' | 'replay';

/** Matches that run on this machine only: they can pause and change speed. */
export function isLocalMode(mode: MatchMode): boolean {
  return mode !== 'online';
}
export type AiDifficulty = NonNullable<PlayerSlot['aiDifficulty']>;

/** Lobby-facing summary of a map (built from `data/maps/*.json` via `mapInfoFromDef`). */
export interface MapInfo {
  id: string;
  name: string;
  /** Number of spawns the map declares. */
  maxPlayers: number;
  /** Side length in meters. */
  size: number;
  description?: string;
  spawns: { x: number; z: number }[];
  /** Layouts the map is made for, e.g. ['1v1', '2v2', 'ffa4']. */
  modes?: string[];
}

export type SlotOccupant = { kind: 'human'; peerId: string; name: string } | { kind: 'ai'; difficulty: AiDifficulty };

export interface LobbySlot {
  /** 0-based slot position. Player ids in the MatchSetup are assigned in slot order. */
  index: number;
  state: 'open' | 'closed' | 'taken';
  occupant: SlotOccupant | null;
  team: TeamId;
  /** CSS hex color. Unique per taken slot. */
  color: string;
  /** AI slots are always ready. */
  ready: boolean;
  /** Round-trip time to that peer, if known. */
  pingMs?: number;
  /** Co-op role (shared command). */
  role?: CommandRole;
}

export type LobbyStatus = 'connecting' | 'open' | 'starting' | 'closed';

export interface LobbyState {
  /** Room code (6 chars), or null for an offline skirmish. */
  code: string | null;
  selfId: string;
  hostId: string;
  mapId: string;
  victory: VictoryMode;
  /** Shared-command co-op: the humans of each team run one army together. */
  coop?: boolean;
  slots: LobbySlot[];
  status: LobbyStatus;
  /** Set when status is 'closed' because of an error (host left, kicked, network). */
  error?: string;
}

export interface ChatMessage {
  /** Peer id, or 'system' for join/leave notices. */
  from: string;
  name: string;
  text: string;
  /** Local receive time (ms since epoch). */
  at: number;
}

export type SlotOccupancy = 'open' | 'closed' | { ai: AiDifficulty };

export interface LobbyApi {
  getState(): LobbyState;
  /** Called after every state change. Returns an unsubscribe function. */
  subscribe(fn: (state: LobbyState) => void): () => void;
  onChat(fn: (msg: ChatMessage) => void): () => void;
  /** Fires on every peer when the host starts. Hand the setup to `UiApp.onStartMatch`. */
  onStart(fn: (setup: MatchSetup) => void): () => void;

  setName(name: string): void;
  /** Team/color/ready of a slot. Peers may edit their own slot; the host may edit any slot's team/color. */
  updateSlot(index: number, patch: SlotPatchUi): void;
  /** Move yourself to an open slot. */
  moveToSlot(index: number): void;
  sendChat(text: string): void;

  // Host only. Calls from non-hosts are ignored.
  setMap(mapId: string): void;
  setVictory(mode: VictoryMode): void;
  /** Host: turn shared-command co-op on or off. Optional for connectors that don't support it. */
  setCoop?(on: boolean): void;
  setOccupancy(index: number, occupancy: SlotOccupancy): void;
  kick(peerId: string): void;
  start(): void;

  leave(): void;
}

export interface LobbyConnector {
  /** Create a room. Resolves once the room is announced and joinable. */
  host(name: string): Promise<LobbyApi>;
  /** Join by room code. Rejects with a readable Error ("Room not found", ...). */
  join(code: string, name: string): Promise<LobbyApi>;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers (pure; also used by real adapters).

export const TEAM_COLORS = ['#4f8fe6', '#d9503f', '#e3b23c', '#4fbf7a', '#a66ee0', '#e07b39', '#46c4c4', '#d4d4c8'];

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  return s;
}

/** Uppercases and strips separators; returns null if it can't be a room code. */
export function normalizeRoomCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== ROOM_CODE_LENGTH) return null;
  for (const c of s) if (!ROOM_CODE_ALPHABET.includes(c)) return null;
  return s;
}

/** Reads `#room=CODE` from a location hash. */
export function roomCodeFromHash(hash: string): string | null {
  const m = /(?:^#|&)room=([^&]+)/.exec(hash);
  return m ? normalizeRoomCode(decodeURIComponent(m[1])) : null;
}

export function shareLink(code: string, loc: { origin: string; pathname: string } = location): string {
  return `${loc.origin}${loc.pathname}#room=${code}`;
}

export function mapInfoFromDef(def: MapDef, description?: string): MapInfo {
  return {
    id: def.id,
    name: def.name,
    maxPlayers: Math.min(def.spawns.length, MAX_PLAYERS),
    size: def.size,
    description,
    spawns: def.spawns.map((s) => ({ x: s.x, z: s.z })),
    ...(def.modes ? { modes: def.modes } : {}),
  };
}

export function takenSlots(state: LobbyState): LobbySlot[] {
  return state.slots.filter((s) => s.state === 'taken' && s.occupant);
}

export function selfSlot(state: LobbyState): LobbySlot | undefined {
  return state.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.peerId === state.selfId);
}

export function isHost(state: LobbyState): boolean {
  return state.selfId === state.hostId;
}

/** Why the host can't start yet, or null if it can. */
export function startBlocker(state: LobbyState): string | null {
  const players = takenSlots(state);
  if (players.length < 2) return 'Need at least 2 players';
  const teams = new Set(players.map((s) => s.team));
  if (teams.size < 2) return 'Everyone is on the same team';
  const notReady = players.filter((s) => !s.ready && s.occupant?.kind === 'human' && s.occupant.peerId !== state.hostId);
  if (notReady.length) return `Waiting for ${notReady.length} player${notReady.length > 1 ? 's' : ''} to ready up`;
  return null;
}

/** Player ids are assigned in slot order over taken slots (0..n-1), so they index map spawns. */
export function buildMatchSetup(state: LobbyState, seed: number): MatchSetup {
  let players: PlayerSlot[] = takenSlots(state).map((s, i) => {
    const o = s.occupant!;
    return o.kind === 'human'
      ? { id: i, team: s.team, name: o.name, color: s.color, kind: 'human', ...(state.coop && s.role ? { role: s.role } : {}) }
      : { id: i, team: s.team, name: `AI (${o.difficulty})`, color: s.color, kind: 'ai', aiDifficulty: o.difficulty };
  });
  if (state.coop) players = sharedArmies(players);
  return { seed: seed >>> 0, mapId: state.mapId, players, victory: state.victory };
}

/** Shared command: each team's first human leads its army, the team's other humans join it. */
export function sharedArmies(players: PlayerSlot[]): PlayerSlot[] {
  const leader = new Map<TeamId, number>();
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

/** The local player's id in the setup `buildMatchSetup` makes from this state (-1 = spectator). */
export function selfPlayerId(state: LobbyState): number {
  return takenSlots(state).findIndex((s) => s.occupant?.kind === 'human' && s.occupant.peerId === state.selfId);
}

/** Lowest unused color, so new slots don't collide. */
export function freeColor(slots: LobbySlot[], exceptIndex = -1): string {
  const used = new Set(slots.filter((s) => s.state === 'taken' && s.index !== exceptIndex).map((s) => s.color));
  return TEAM_COLORS.find((c) => !used.has(c)) ?? TEAM_COLORS[0];
}

// ---------------------------------------------------------------------------------------------
// In-memory implementation: offline skirmish, and a fake online room for developing the UI.

type Listener<T> = (v: T) => void;

class Emitter<T> {
  private fns = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(v: T): void {
    for (const fn of [...this.fns]) fn(v);
  }
  clear(): void {
    this.fns.clear();
  }
}

export interface MemoryLobbyOptions {
  maps: MapInfo[];
  selfName: string;
  /** null = offline skirmish (no ready check, AI slots). */
  code: string | null;
  selfIsHost: boolean;
  /** Scheduler for simulated network latency. Defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * A lobby that lives in this tab. Offline skirmish uses it as-is. The fake online room adds
 * scripted peers (see FakeLobbyConnector) so every screen state can be exercised without a network.
 */
export class MemoryLobby implements LobbyApi {
  private state: LobbyState;
  private readonly changes = new Emitter<LobbyState>();
  private readonly chat = new Emitter<ChatMessage>();
  private readonly starts = new Emitter<MatchSetup>();
  private readonly names = new Map<string, string>();
  /** Chat so far, replayed to late subscribers (the screen subscribes after the room opens). */
  private readonly history: ChatMessage[] = [];
  readonly maps: MapInfo[];
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(opts: MemoryLobbyOptions) {
    this.maps = opts.maps;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    const map = opts.maps[0];
    if (!map) throw new Error('MemoryLobby needs at least one map');
    const selfId = 'self';
    this.names.set(selfId, opts.selfName);
    this.state = {
      code: opts.code,
      selfId,
      hostId: opts.selfIsHost ? selfId : 'host',
      mapId: map.id,
      victory: 'frontline',
      slots: [],
      status: 'open',
    };
    this.state.slots = this.makeSlots(map.maxPlayers, []);
  }

  /** Slot layout for a map; keeps existing occupants in order where they fit. */
  private makeSlots(count: number, keep: LobbySlot[]): LobbySlot[] {
    const slots: LobbySlot[] = [];
    for (let i = 0; i < count; i++) {
      slots.push({ index: i, state: 'open', occupant: null, team: i % 2, color: TEAM_COLORS[i], ready: false });
    }
    keep
      .filter((s) => s.state === 'taken' || s.state === 'closed')
      .slice(0, count)
      .forEach((s) => {
        const dst = slots[Math.min(s.index, count - 1)].state === 'open' ? slots[Math.min(s.index, count - 1)] : slots.find((d) => d.state === 'open');
        if (!dst) return;
        Object.assign(dst, { state: s.state, occupant: s.occupant, team: s.team, color: s.color, ready: s.ready, pingMs: s.pingMs });
      });
    return slots;
  }

  getState(): LobbyState {
    return this.state;
  }

  subscribe(fn: (s: LobbyState) => void): () => void {
    return this.changes.on(fn);
  }

  onChat(fn: (m: ChatMessage) => void): () => void {
    for (const m of this.history) fn(m);
    return this.chat.on(fn);
  }

  private say(m: ChatMessage): void {
    this.history.push(m);
    if (this.history.length > 200) this.history.shift();
    this.chat.emit(m);
  }

  onStart(fn: (s: MatchSetup) => void): () => void {
    return this.starts.on(fn);
  }

  private commit(mut: (s: LobbyState) => void): void {
    if (this.state.status === 'closed') return;
    const next: LobbyState = { ...this.state, slots: this.state.slots.map((s) => ({ ...s })) };
    mut(next);
    this.state = next;
    this.changes.emit(next);
  }

  private get hosting(): boolean {
    return isHost(this.state);
  }

  private get offline(): boolean {
    return this.state.code === null;
  }

  system(text: string): void {
    this.say({ from: 'system', name: 'SYSTEM', text, at: Date.now() });
  }

  // --- peer-side API

  setName(name: string): void {
    const n = name.trim().slice(0, 20);
    if (!n) return;
    this.names.set(this.state.selfId, n);
    this.commit((s) => {
      for (const slot of s.slots) {
        if (slot.occupant?.kind === 'human' && slot.occupant.peerId === s.selfId) slot.occupant = { ...slot.occupant, name: n };
      }
    });
  }

  updateSlot(index: number, patch: SlotPatchUi): void {
    this.updateSlotAs(this.state.selfId, index, patch);
  }

  /** Apply a slot edit on behalf of `peerId` (self or a simulated peer). */
  updateSlotAs(peerId: string, index: number, patch: SlotPatchUi): void {
    const slot = this.state.slots[index];
    if (!slot || slot.state !== 'taken') return;
    const own = slot.occupant?.kind === 'human' && slot.occupant.peerId === peerId;
    const hostEdit = peerId === this.state.hostId;
    if (!own && !hostEdit) return;
    this.commit((s) => {
      const d = s.slots[index];
      if (patch.team !== undefined && Number.isInteger(patch.team) && patch.team >= 0 && patch.team < MAX_PLAYERS) d.team = patch.team;
      if (patch.color !== undefined && TEAM_COLORS.includes(patch.color)) {
        // Swap with whoever had that color.
        const other = s.slots.find((o) => o.state === 'taken' && o.color === patch.color && o.index !== index);
        if (other) other.color = d.color;
        d.color = patch.color;
      }
      if (patch.ready !== undefined && own) d.ready = patch.ready;
      if (patch.role === '') delete d.role;
      else if (patch.role) d.role = patch.role;
      // Changing setup un-readies you, like most lobbies, so nobody gets surprised.
      if ((patch.team !== undefined || patch.color !== undefined) && own && patch.ready === undefined && d.occupant?.kind === 'human' && peerId !== s.hostId) d.ready = false;
    });
  }

  moveToSlot(index: number): void {
    this.movePeer(this.state.selfId, index);
  }

  private movePeer(peerId: string, index: number): void {
    const dst = this.state.slots[index];
    const src = this.state.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.peerId === peerId);
    if (!dst || !src || dst.state !== 'open') return;
    this.commit((s) => {
      const d = s.slots[index];
      const o = s.slots[src.index];
      Object.assign(d, { state: 'taken', occupant: o.occupant, color: o.color, ready: false, pingMs: o.pingMs });
      Object.assign(o, { state: 'open', occupant: null, ready: false, pingMs: undefined });
    });
  }

  sendChat(text: string): void {
    this.chatAs(this.state.selfId, text);
  }

  chatAs(peerId: string, text: string): void {
    const t = text.trim().slice(0, 240);
    if (!t) return;
    this.say({ from: peerId, name: this.names.get(peerId) ?? peerId, text: t, at: Date.now() });
  }

  // --- host-side API

  setMap(mapId: string): void {
    this.setMapAs(this.state.selfId, mapId);
  }

  setMapAs(peerId: string, mapId: string): void {
    const map = this.maps.find((m) => m.id === mapId);
    if (!map || peerId !== this.state.hostId) return;
    this.commit((s) => {
      s.mapId = mapId;
      const kept = s.slots;
      s.slots = this.makeSlots(map.maxPlayers, kept);
      for (const slot of s.slots) if (slot.occupant?.kind === 'human' && slot.occupant.peerId !== s.hostId) slot.ready = false;
    });
  }

  setCoop(on: boolean): void {
    if (!this.hosting) return;
    this.commit((s) => {
      s.coop = on;
    });
  }

  setVictory(mode: 'frontline' | 'annihilation'): void {
    if (!this.hosting) return;
    this.commit((s) => {
      s.victory = mode;
    });
  }

  setOccupancy(index: number, occ: SlotOccupancy): void {
    if (!this.hosting) return;
    const slot = this.state.slots[index];
    if (!slot || slot.occupant?.kind === 'human') return;
    this.commit((s) => {
      const d = s.slots[index];
      if (occ === 'open' || occ === 'closed') Object.assign(d, { state: occ, occupant: null, ready: false });
      else Object.assign(d, { state: 'taken', occupant: { kind: 'ai', difficulty: occ.ai }, ready: true, color: d.state === 'taken' ? d.color : freeColor(s.slots, index) });
    });
  }

  kick(peerId: string): void {
    if (!this.hosting || peerId === this.state.selfId) return;
    this.removePeer(peerId, 'was removed by the host');
  }

  start(): void {
    if (!this.hosting || this.state.status !== 'open') return;
    const blocker = startBlocker(this.state);
    if (blocker && !(this.offline && blocker.startsWith('Waiting'))) return;
    this.launch();
  }

  /** Flip to 'starting' and fire onStart with a fresh seed. */
  launch(): void {
    this.commit((s) => {
      s.status = 'starting';
    });
    const setup = buildMatchSetup(this.state, Math.floor(Math.random() * 0xffffffff));
    this.starts.emit(setup);
  }

  leave(): void {
    if (this.state.status === 'closed') return;
    this.commit((s) => {
      s.status = 'closed';
    });
    this.changes.clear();
    this.chat.clear();
    this.starts.clear();
  }

  // --- simulation hooks for FakeLobbyConnector

  addPeer(peerId: string, name: string, pingMs: number, announce = true): boolean {
    const open = this.state.slots.find((s) => s.state === 'open');
    if (!open) return false;
    this.names.set(peerId, name);
    this.commit((s) => {
      Object.assign(s.slots[open.index], {
        state: 'taken',
        occupant: { kind: 'human', peerId, name },
        color: freeColor(s.slots, open.index),
        ready: false,
        pingMs,
      });
    });
    if (announce) this.system(`${name} joined`);
    return true;
  }

  removePeer(peerId: string, why = 'left'): void {
    const slot = this.state.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.peerId === peerId);
    if (!slot) return;
    const name = this.names.get(peerId) ?? peerId;
    this.commit((s) => {
      Object.assign(s.slots[slot.index], { state: 'open', occupant: null, ready: false, pingMs: undefined });
    });
    this.system(`${name} ${why}`);
  }

  setReadyAs(peerId: string, ready: boolean): void {
    const slot = this.state.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.peerId === peerId);
    if (slot) this.updateSlotAs(peerId, slot.index, { ready });
  }

  /** Put self into the first open slot (joining someone else's room). */
  seatSelf(pingMs?: number): void {
    const open = this.state.slots.find((s) => s.state === 'open');
    if (!open) return;
    const name = this.names.get(this.state.selfId)!;
    this.commit((s) => {
      Object.assign(s.slots[open.index], {
        state: 'taken',
        occupant: { kind: 'human', peerId: s.selfId, name },
        color: freeColor(s.slots, open.index),
        ready: false,
        pingMs,
      });
    });
  }

  later(fn: () => void, ms: number): void {
    this.schedule(() => {
      if (this.state.status !== 'closed') fn();
    }, ms);
  }
}

/** Offline skirmish: you in slot 0, one Normal AI in slot 1, other slots open for more AIs. */
export function createSkirmishLobby(selfName: string, maps: MapInfo[]): MemoryLobby {
  const lobby = new MemoryLobby({ maps, selfName, code: null, selfIsHost: true });
  lobby.seatSelf();
  lobby.setOccupancy(1, { ai: 'normal' });
  return lobby;
}

const FAKE_PEERS = ['Sgt. Okafor', 'Lt. Varga', 'Cpl. Brandt', 'Maj. Ishikawa', 'Pvt. Duarte', 'Capt. Lindqvist', 'Sgt. Moreau'];
const FAKE_CHATTER = ['o7', 'gl hf', 'ready when you are', 'which map?', 'no rush on T1 pls', 'brb coffee', 'lets go'];

/**
 * Pretend P2P rooms for UI development. Hosting fills the room with scripted peers who join,
 * chat and ready up; joining any well-formed code puts you in a room run by a scripted host who
 * starts the match once everyone is ready.
 */
export class FakeLobbyConnector implements LobbyConnector {
  constructor(
    private readonly maps: MapInfo[],
    private readonly opts: { latencyMs?: number; peers?: number } = {},
  ) {}

  async host(name: string): Promise<LobbyApi> {
    await wait(this.opts.latencyMs ?? 500);
    const lobby = new MemoryLobby({ maps: this.maps, selfName: name, code: randomRoomCode(), selfIsHost: true });
    lobby.seatSelf(0);
    lobby.system(`Room ${lobby.getState().code} is open. Share the link to invite players.`);
    const peers = Math.min(this.opts.peers ?? 1, lobby.getState().slots.length - 1);
    for (let i = 0; i < peers; i++) {
      const id = `peer${i}`;
      lobby.later(() => {
        lobby.addPeer(id, FAKE_PEERS[i % FAKE_PEERS.length], 30 + Math.floor(Math.random() * 90));
        lobby.later(() => lobby.chatAs(id, FAKE_CHATTER[(i * 3) % FAKE_CHATTER.length]), 900);
        lobby.later(() => lobby.setReadyAs(id, true), 2200 + i * 700);
      }, 1400 + i * 1600);
    }
    return lobby;
  }

  async join(code: string, name: string): Promise<LobbyApi> {
    const norm = normalizeRoomCode(code);
    await wait(this.opts.latencyMs ?? 700);
    if (!norm) throw new Error('That is not a valid room code');
    const lobby = new MemoryLobby({ maps: this.maps, selfName: name, code: norm, selfIsHost: false });
    // The scripted host sits in slot 0.
    const hostName = FAKE_PEERS[0];
    lobby.addPeer('host', hostName, 40 + Math.floor(Math.random() * 60), false);
    lobby.setReadyAs('host', true);
    lobby.seatSelf();
    lobby.system(`Connected to room ${norm}`);
    lobby.later(() => lobby.chatAs('host', 'welcome, ready up when set'), 1200);
    // Start shortly after you ready up.
    let armed = false;
    lobby.subscribe((s) => {
      const me = selfSlot(s);
      if (!armed && me?.ready && s.status === 'open' && !startBlocker(s)) {
        armed = true;
        lobby.chatAs('host', 'starting in 3');
        lobby.later(() => {
          const now = lobby.getState();
          if (selfSlot(now)?.ready && now.status === 'open') lobby.launch();
          armed = false;
        }, 2500);
      }
    });
    return lobby;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
