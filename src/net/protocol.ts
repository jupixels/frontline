import type { Command, Turn } from '../shared/commands';
import type { CommandRole, MatchSetup, PlayerId, TeamId, VictoryMode } from '../shared/types';

/**
 * Wire protocol. Every message is plain JSON with a `t` tag. Bump PROTOCOL_VERSION on any
 * incompatible change; peers with a different version are rejected at the lobby.
 */
export const PROTOCOL_VERSION = 2;

/** Transport-level peer id (random per page load). */
export type PeerId = string;

// ---------------------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------------------

export type SlotState = 'open' | 'closed' | 'human' | 'ai';
export type AiDifficulty = 'easy' | 'normal' | 'hard';

export interface LobbySlot {
  /** Slot index 0..maxPlayers-1. Player ids are assigned in slot order at start. */
  index: number;
  state: SlotState;
  /** Set for human slots. */
  peer?: PeerId;
  name: string;
  team: TeamId;
  /** CSS hex color. */
  color: string;
  /** Placeholder until factions exist. */
  faction: string;
  ready: boolean;
  aiDifficulty?: AiDifficulty;
  /** Internal: SHA-256 of the player's rejoin secret. UIs ignore it. */
  secretHash?: string;
  /** Round trip between the host and this player, ms (host-measured; unset for the host itself). */
  pingMs?: number;
  /** Shared-command co-op role (only used when settings.coop is on). */
  role?: CommandRole;
}

export interface LobbySettings {
  mapId: string;
  victory: VictoryMode;
  /** 2..8. Slots beyond this are hidden. */
  maxPlayers: number;
  /** Shared command: the humans of each team run one army together (see PlayerSlot.army). */
  coop?: boolean;
}

export interface LobbyState {
  code: string;
  hostPeer: PeerId;
  settings: LobbySettings;
  slots: LobbySlot[];
  phase: 'lobby' | 'inGame';
}

/** What a player may change about their own slot. */
export interface SlotPatch {
  name?: string;
  team?: TeamId;
  color?: string;
  faction?: string;
  ready?: boolean;
  /** '' clears the role. */
  role?: CommandRole | '';
}

export interface ChatMessage {
  /** Sender's slot index, or -1 for system messages. */
  slot: number;
  name: string;
  text: string;
}

export type RejectReason = 'full' | 'in-progress' | 'version' | 'kicked' | 'rejoin-denied' | 'rejoin-expired';

// ---------------------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------------------

/**
 * A span of blocks during which `peer` sends inputs for a player. `until` null = open-ended.
 * A player is waited on for block b iff one of its segments contains b.
 */
export interface Segment {
  peer: PeerId;
  from: number;
  until: number | null;
}

/** Everything a peer needs to run a match, sent by the host at start (and inside `sync`). */
export interface StartInfo {
  matchId: string;
  setup: MatchSetup;
  /** Ticks per lockstep block (turn). */
  turnTicks: number;
  segments: [PlayerId, Segment[]][];
  /** SHA-256 of each human player's rejoin secret. */
  secretHashes: [PlayerId, string][];
  rejoinWindowMs: number;
}

/** [player, block, peer that sent it, commands] */
export type RawInput = [PlayerId, number, PeerId, Command[]];

/** Sent by the authority to a rejoining peer so it can fast-forward. */
export interface SyncPayload {
  start: StartInfo;
  /** The rejoiner's player and the block it sends inputs from. */
  player: PlayerId;
  resumeBlock: number;
  /** Highest block the authority has applied; `turns` covers everything up to it. */
  appliedBlock: number;
  turns: Turn[];
  /** Inputs the authority holds for blocks after `appliedBlock`. */
  inputs: RawInput[];
  /** The authority's own state hashes, so the rejoiner can check its fast-forward. */
  hashes: [number, number][];
  /** Players already gone, with the tick they left at. */
  left: [PlayerId, number][];
}

export interface CtlChange {
  player: PlayerId;
  peer: PeerId;
}

export interface RejoinRequest {
  matchId: string;
  player: PlayerId;
  secret: string;
}

export type NetMessage =
  // lobby
  | { t: 'hello'; v: number; name: string; secretHash: string; rejoin?: RejoinRequest }
  | { t: 'welcome'; state: LobbyState }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'lobby'; state: LobbyState }
  | { t: 'slotReq'; patch: SlotPatch }
  | { t: 'moveReq'; index: number }
  | { t: 'lping'; ts: number }
  | { t: 'lpong'; ts: number }
  | { t: 'chat'; text: string }
  | { t: 'chatMsg'; msg: ChatMessage }
  | { t: 'kicked' }
  | { t: 'start'; start: StartInfo }
  // match
  | { t: 'in'; b: number; c: [PlayerId, Command[]][]; ctl?: CtlChange[] }
  /** `blk`: the sender's current block, so peers can tell when they've fallen behind. */
  | { t: 'ping'; ts: number; blk?: number }
  | { t: 'pong'; ts: number }
  | { t: 'hash'; tick: number; h: number }
  | { t: 'bye' }
  | { t: 'dropBegin'; peer: PeerId }
  | { t: 'dropReport'; peer: PeerId; max: number; inputs: RawInput[] }
  | { t: 'dropFinal'; peer: PeerId; last: number; inputs: RawInput[]; reassign: [PlayerId, PeerId][] }
  | { t: 'sync'; sync: SyncPayload };

export type MessageType = NetMessage['t'];

/** Messages handled by the match session (buffered by the lobby until the session exists). */
export const MATCH_MESSAGES: ReadonlySet<MessageType> = new Set<MessageType>([
  'in',
  'ping',
  'pong',
  'hash',
  'bye',
  'dropBegin',
  'dropReport',
  'dropFinal',
]);
