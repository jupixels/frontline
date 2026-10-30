import { hostLobby, joinLobby, NetError, type Lobby, type StartedMatch } from '../net';
import type { LobbySlot as NetSlot } from '../net/protocol';
import type { MatchSetup, TeamId, VictoryMode } from '../shared/types';
import type { ChatMessage, LobbyApi, LobbyConnector, LobbySlot, LobbyState, SlotOccupancy } from '../ui';
import { MAPS } from './content';

const NET_ERRORS: Record<string, string> = {
  'signaling-unavailable': "Couldn't reach the matchmaking relays. Check your connection and try again.",
  'host-unreachable': 'Room not found, or the host is unreachable.',
  rejected: 'The host refused the connection.',
  closed: 'Left the lobby.',
};

function errorText(err: unknown): string {
  if (err instanceof NetError) {
    const reason = err.reason;
    if (reason === 'full') return 'That room is full.';
    if (reason === 'in-progress') return 'That match has already started.';
    if (reason === 'kicked') return 'You were removed from the room.';
    if (reason === 'version') return 'That room runs a different game version. Reload the page.';
    return NET_ERRORS[err.code] ?? err.message;
  }
  return (err as Error)?.message ?? String(err);
}

/** Adapts the networking session's `Lobby` to the UI's `LobbyApi`. */
export class NetLobbyAdapter implements LobbyApi {
  /** Set when the match starts; the match runner takes the lockstep session from here. */
  match: StartedMatch | null = null;
  private closedError: string | null = null;
  private closed = false;

  constructor(readonly lobby: Lobby) {
    lobby.on('closed', (err) => {
      this.closed = true;
      if (err.code !== 'closed') this.closedError = errorText(err);
    });
  }

  getState(): LobbyState {
    const l = this.lobby;
    const s = l.snapshot;
    return {
      code: l.code,
      selfId: l.selfId,
      hostId: s.hostPeer,
      mapId: s.settings.mapId,
      victory: s.settings.victory,
      slots: l.slots.map(toUiSlot),
      status: this.closed ? 'closed' : s.phase === 'inGame' ? 'starting' : 'open',
      ...(this.closedError ? { error: this.closedError } : {}),
    };
  }

  subscribe(fn: (state: LobbyState) => void): () => void {
    const offChange = this.lobby.on('change', () => fn(this.getState()));
    const offClosed = this.lobby.on('closed', () => queueMicrotask(() => fn(this.getState())));
    return () => {
      offChange();
      offClosed();
    };
  }

  onChat(fn: (msg: ChatMessage) => void): () => void {
    return this.lobby.on('chat', (m) => {
      const slot = this.lobby.snapshot.slots[m.slot];
      fn({ from: m.slot < 0 ? 'system' : (slot?.peer ?? `slot${m.slot}`), name: m.name, text: m.text, at: Date.now() });
    });
  }

  onStart(fn: (setup: MatchSetup) => void): () => void {
    const go = (m: StartedMatch) => {
      this.match = m;
      fn(m.setup);
    };
    // Rejoined after a reload: the match was already running when we subscribed.
    if (this.lobby.match) {
      const m = this.lobby.match;
      queueMicrotask(() => go(m));
    }
    return this.lobby.on('start', go);
  }

  setName(name: string): void {
    this.lobby.updateSelf({ name });
  }

  updateSlot(index: number, patch: { team?: TeamId; color?: string; ready?: boolean }): void {
    const slot = this.lobby.snapshot.slots[index];
    if (!slot) return;
    if (slot.peer === this.lobby.selfId) this.lobby.updateSelf(patch);
    else if (slot.state === 'ai') this.lobby.setAiSlot(index, { team: patch.team, color: patch.color });
    else if (slot.state === 'human') this.lobby.setPlayerSlot(index, { team: patch.team, color: patch.color });
  }

  moveToSlot(index: number): void {
    this.lobby.moveToSlot(index);
  }

  sendChat(text: string): void {
    this.lobby.sendChat(text);
  }

  setMap(mapId: string): void {
    this.lobby.setSettings({ mapId });
  }

  setVictory(victory: VictoryMode): void {
    this.lobby.setSettings({ victory });
  }

  setOccupancy(index: number, occ: SlotOccupancy): void {
    const slot = this.lobby.snapshot.slots[index];
    if (!slot || slot.state === 'human') return;
    if (occ === 'open' || occ === 'closed') this.lobby.setSlotOpen(index, occ === 'open');
    else if (slot.state === 'ai') this.lobby.setAiSlot(index, { aiDifficulty: occ.ai });
    else this.lobby.addAi(occ.ai, index);
  }

  kick(peerId: string): void {
    const slot = this.lobby.snapshot.slots.find((s) => s.peer === peerId);
    if (slot) this.lobby.kick(slot.index);
  }

  start(): void {
    this.lobby.start().catch((err) => console.warn('[lobby] start failed', err));
  }

  leave(): void {
    this.lobby.leave();
  }
}

function toUiSlot(s: NetSlot): LobbySlot {
  const taken = s.state === 'human' || s.state === 'ai';
  return {
    index: s.index,
    state: taken ? 'taken' : s.state === 'closed' ? 'closed' : 'open',
    occupant:
      s.state === 'human' && s.peer
        ? { kind: 'human', peerId: s.peer, name: s.name }
        : s.state === 'ai'
          ? { kind: 'ai', difficulty: s.aiDifficulty ?? 'normal' }
          : null,
    team: s.team,
    color: s.color,
    ready: s.state === 'ai' ? true : s.ready,
    ...(s.pingMs !== undefined ? { pingMs: s.pingMs } : {}),
  };
}

/** Real P2P rooms over public relays. */
export const netLobbyConnector: LobbyConnector = {
  async host(name) {
    try {
      return new NetLobbyAdapter(await hostLobby({ name, settings: { mapId: MAPS[0].id } }));
    } catch (err) {
      throw new Error(errorText(err));
    }
  },
  async join(code, name) {
    try {
      return new NetLobbyAdapter(await joinLobby(code, { name }));
    } catch (err) {
      throw new Error(errorText(err));
    }
  },
};
