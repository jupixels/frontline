// Public surface of net/. UI and game code import from here.
export { LocalSession, type NetSession } from './session';
export {
  hostLobby,
  joinLobby,
  Lobby,
  makeRoomCode,
  normalizeRoomCode,
  roomCodeFromUrl,
  shareUrl,
  PLAYER_COLORS,
  type LobbyEvents,
  type LobbyOptions,
  type RejoinTicket,
  type StartCheck,
  type StartedMatch,
} from './lobby';
export { LockstepSession, type DesyncInfo, type SessionEvents, type SessionStatus } from './lockstep';
export { downloadReplay, parseReplay, ReplaySession, serializeReplay, type CommandLog, type ReplayFile } from './replay';
export { NetError, type NetErrorCode, type Transport, type TransportFactory, type TransportStatus } from './transport';
export { trysteroTransport, PUBLIC_STUN, type TrysteroOptions } from './trystero';
export { LoopbackNetwork } from './loopback';
export type { AiDifficulty, ChatMessage, LobbySettings, LobbySlot, LobbyState, SlotPatch } from './protocol';
