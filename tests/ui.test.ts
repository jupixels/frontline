import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityState, PlayerState, SimView } from '../src/shared/entities';
import type { MatchSetup } from '../src/shared/types';
import { StatsTracker } from '../src/ui/hud/stats';
import { ACTIONS, conflicts, defaultKeybinds, isBindable, KEYBINDS_VERSION, keyLabel, rebind } from '../src/ui/keybinds';
import {
  FakeLobbyConnector,
  MemoryLobby,
  buildMatchSetup,
  createSkirmishLobby,
  normalizeRoomCode,
  randomRoomCode,
  roomCodeFromHash,
  selfPlayerId,
  selfSlot,
  startBlocker,
  type MapInfo,
} from '../src/ui/lobbyApi';
import { parseCredits } from '../src/ui/screens/credits';
import { SettingsStore, sanitizeSettings, type KeyValueStore } from '../src/ui/settings';
import { SimAdapter } from '../src/ui/simAdapter';

const MAPS: MapInfo[] = [
  { id: 'four', name: 'Four', maxPlayers: 4, size: 600, spawns: [{ x: -1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: -1 }, { x: 1, z: 1 }] },
  { id: 'two', name: 'Two', maxPlayers: 2, size: 400, spawns: [{ x: -1, z: 0 }, { x: 1, z: 0 }] },
];

describe('room codes', () => {
  it('generates and normalizes 6-char codes', () => {
    const code = randomRoomCode();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(normalizeRoomCode(code.toLowerCase())).toBe(code);
    expect(normalizeRoomCode('k7q-2mx')).toBe('K7Q2MX');
    expect(normalizeRoomCode('ABC')).toBeNull();
    // 0/O/1/I are excluded to avoid misreads.
    expect(normalizeRoomCode('O0I1AB')).toBeNull();
  });

  it('reads #room=CODE from the hash', () => {
    expect(roomCodeFromHash('#room=k7q2mx')).toBe('K7Q2MX');
    expect(roomCodeFromHash('#foo=1&room=K7Q2MX')).toBe('K7Q2MX');
    expect(roomCodeFromHash('#lobby')).toBeNull();
  });
});

describe('MemoryLobby (skirmish)', () => {
  it('seats the player and a Normal AI and can start without ready checks', () => {
    const lobby = createSkirmishLobby('Ace', MAPS);
    const s = lobby.getState();
    expect(s.code).toBeNull();
    expect(selfSlot(s)?.index).toBe(0);
    expect(s.slots[1].occupant).toEqual({ kind: 'ai', difficulty: 'normal' });
    expect(startBlocker(s)).toBeNull();
    const started = vi.fn();
    lobby.onStart(started);
    lobby.start();
    expect(started).toHaveBeenCalledOnce();
    const setup: MatchSetup = started.mock.calls[0][0];
    expect(setup.players.map((p) => p.kind)).toEqual(['human', 'ai']);
    expect(lobby.getState().status).toBe('starting');
  });

  it('assigns player ids in slot order over taken slots only', () => {
    const lobby = createSkirmishLobby('Ace', MAPS);
    lobby.setOccupancy(1, 'closed');
    lobby.setOccupancy(3, { ai: 'hard' });
    const setup = buildMatchSetup(lobby.getState(), 7);
    expect(setup.players.map((p) => p.id)).toEqual([0, 1]);
    expect(setup.players[1].aiDifficulty).toBe('hard');
    expect(selfPlayerId(lobby.getState())).toBe(0);
  });

  it('blocks a start with everyone on one team', () => {
    const lobby = createSkirmishLobby('Ace', MAPS);
    lobby.updateSlot(1, { team: 0 });
    expect(startBlocker(lobby.getState())).toMatch(/same team/);
  });

  it('swaps colors instead of duplicating them', () => {
    const lobby = createSkirmishLobby('Ace', MAPS);
    const [a, b] = lobby.getState().slots;
    lobby.updateSlot(0, { color: b.color });
    const after = lobby.getState().slots;
    expect(after[0].color).toBe(b.color);
    expect(after[1].color).toBe(a.color);
  });

  it('keeps occupants when the host switches to a smaller map', () => {
    const lobby = createSkirmishLobby('Ace', MAPS);
    lobby.setOccupancy(2, { ai: 'easy' });
    lobby.setMap('two');
    const s = lobby.getState();
    expect(s.slots).toHaveLength(2);
    expect(s.slots.filter((x) => x.state === 'taken')).toHaveLength(2);
  });
});

describe('MemoryLobby (online)', () => {
  it('ignores host-only calls from a peer and requires ready before start', () => {
    const lobby = new MemoryLobby({ maps: MAPS, selfName: 'Me', code: 'K7Q2MX', selfIsHost: false, schedule: () => {} });
    lobby.addPeer('host', 'Host', 30);
    lobby.seatSelf();
    lobby.setMap('two');
    lobby.setVictory('annihilation');
    expect(lobby.getState().mapId).toBe('four');
    expect(lobby.getState().victory).toBe('frontline');
    const me = selfSlot(lobby.getState())!;
    lobby.updateSlot(me.index, { team: 1 });
    expect(startBlocker(lobby.getState())).toMatch(/ready/);
    lobby.updateSlot(me.index, { ready: true });
    expect(startBlocker(lobby.getState())).toBeNull();
    // A peer can't edit someone else's slot.
    lobby.updateSlot(0, { team: 3 });
    expect(lobby.getState().slots[0].team).toBe(0);
  });

  it('replays chat history to late subscribers', () => {
    const lobby = new MemoryLobby({ maps: MAPS, selfName: 'Me', code: 'K7Q2MX', selfIsHost: true });
    lobby.system('room open');
    lobby.sendChat('hello');
    const seen: string[] = [];
    lobby.onChat((m) => seen.push(m.text));
    expect(seen).toEqual(['room open', 'hello']);
  });

  describe('FakeLobbyConnector', () => {
    afterEach(() => vi.useRealTimers());

    it('joins a room and the scripted host starts once you are ready', async () => {
      vi.useFakeTimers();
      const fake = new FakeLobbyConnector(MAPS, { latencyMs: 10 });
      const p = fake.join('k7q2mx', 'Me');
      await vi.advanceTimersByTimeAsync(20);
      const lobby = await p;
      const started = vi.fn();
      lobby.onStart(started);
      const me = selfSlot(lobby.getState())!;
      lobby.updateSlot(me.index, { team: 1, ready: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(started).toHaveBeenCalledOnce();
      expect(selfPlayerId(lobby.getState())).toBe(1);
    });

    it('rejects malformed codes', async () => {
      vi.useFakeTimers();
      const fake = new FakeLobbyConnector(MAPS, { latencyMs: 10 });
      const p = fake.join('nope', 'Me');
      const check = expect(p).rejects.toThrow(/valid room code/);
      await vi.advanceTimersByTimeAsync(20);
      await check;
    });
  });
});

describe('keybinds & settings', () => {
  it('swaps keys between conflicting actions', () => {
    const k = rebind(defaultKeybinds(), 'stop', 'KeyQ');
    expect(k.stop).toBe('KeyQ');
    expect(k.attackMove).toBe('KeyX');
  });

  it('defaults: WASD pans the camera and no two live actions share a key', () => {
    const k = defaultKeybinds();
    expect([k.panUp, k.panLeft, k.panDown, k.panRight]).toEqual(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
    for (const a of ACTIONS) for (const b of ACTIONS) if (a.id !== b.id && k[a.id] === k[b.id]) expect(conflicts(a.id, b.id), `${a.id} vs ${b.id}`).toBe(false);
  });

  it('lets placement rotation share a key with a command-card slot', () => {
    const k = rebind(defaultKeybinds(), 'rotateStructure', 'KeyE');
    expect(k.rotateStructure).toBe('KeyE');
    expect(k.slot1).toBe('KeyE');
  });

  it('binding an order to a pan key moves the pan key, never leaving both on it', () => {
    const k = rebind(defaultKeybinds(), 'attackMove', 'KeyA');
    expect(k.attackMove).toBe('KeyA');
    expect(k.panLeft).not.toBe('KeyA');
  });

  it('never leaves two live actions on one key', () => {
    let k = defaultKeybinds();
    for (const code of ['KeyQ', 'KeyA', 'Space', 'F2', 'KeyR']) for (const a of ACTIONS) k = rebind(k, a.id, code);
    const global = ACTIONS.filter((a) => ['centerSelection', 'selectArmy', 'jumpAlert', 'menu'].includes(a.id)).map((a) => k[a.id]);
    expect(new Set(global).size).toBe(global.length);
  });

  it('labels and filters keys', () => {
    expect(keyLabel('KeyA')).toBe('A');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Space')).toBe('Space');
    // Control groups are rebindable now: digits are ordinary keys.
    expect(isBindable('Digit1')).toBe(true);
    expect(isBindable('Escape')).toBe(false);
    expect(isBindable('ShiftLeft')).toBe(false);
    expect(isBindable('KeyG')).toBe(true);
  });

  it('sanitizes stored settings', () => {
    const s = sanitizeSettings({ graphics: 'potato', volume: { master: 7 }, edgePanSpeed: -1, keybinds: { stop: 'KeyZ', bogus: 'KeyM' }, keybindsVersion: KEYBINDS_VERSION });
    expect(s.graphics).toBe('high');
    expect(s.volume.master).toBe(1);
    expect(s.edgePanSpeed).toBe(0);
    expect(s.keybinds.stop).toBe('KeyZ');
    expect(s.keybinds.attackMove).toBe('KeyQ');
  });

  it('migrates binds saved with the old layout (A/S orders) to the WASD-pan defaults', () => {
    const s = sanitizeSettings({ keybinds: { attackMove: 'KeyA', stop: 'KeyS', slot2: 'KeyW', hold: 'KeyG' } });
    expect(s.keybinds).toEqual(defaultKeybinds());
    expect(s.keybindsVersion).toBe(KEYBINDS_VERSION);
  });

  it('resolves a stored clash with the pan keys back to the default', () => {
    const s = sanitizeSettings({ keybinds: { hold: 'KeyW' }, keybindsVersion: KEYBINDS_VERSION });
    expect(s.keybinds.panUp).toBe('KeyW');
    expect(s.keybinds.hold).toBe('KeyH');
  });

  it('persists through the storage', () => {
    const map = new Map<string, string>();
    const storage: KeyValueStore = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
    const a = new SettingsStore(storage);
    a.setKey('hold', 'KeyG');
    a.update({ volume: { music: 0.25 } });
    const b = new SettingsStore(storage);
    expect(b.get().keybinds.hold).toBe('KeyG');
    expect(b.get().volume.music).toBe(0.25);
    expect(b.get().playerName).toBe(a.get().playerName);
  });
});

describe('credits', () => {
  it('reads every bullet of the README credits section', () => {
    const lines = parseCredits(readFileSync('README.md', 'utf8'));
    expect(lines.length).toBeGreaterThanOrEqual(9);
    expect(lines.some((l) => l.includes('Zsky'))).toBe(true);
    expect(lines.some((l) => l.includes('Kevin Iglesias'))).toBe(true);
  });
});

/** Minimal SimView over a mutable entity list. */
function fakeSim(entities: EntityState[], players: PlayerState[]): SimView {
  return {
    tick: 0,
    entities: () => entities,
    get: (id) => entities.find((e) => e.id === id),
    player: (id) => players.find((p) => p.id === id),
  };
}

const unit = (id: number, owner: number, type = 'tank_mbt', kind: EntityState['kind'] = 'unit'): EntityState => ({
  id,
  kind,
  type,
  owner,
  pos: { x: id * 10, z: 0 },
  heading: 0,
  hp: 100,
  maxHp: 100,
  moving: false,
});

const SETUP: MatchSetup = {
  seed: 1,
  mapId: 'four',
  victory: 'frontline',
  players: [
    { id: 0, team: 0, name: 'A', color: '#111111', kind: 'human' },
    { id: 1, team: 1, name: 'B', color: '#222222', kind: 'ai' },
    { id: 2, team: 1, name: 'C', color: '#333333', kind: 'ai' },
  ],
};

describe('StatsTracker', () => {
  it('credits kills, losses and damage even after the victim is removed', () => {
    const ents = [unit(1, 0), unit(2, 1)];
    const sim = fakeSim(ents, []);
    const stats = new StatsTracker(sim, SETUP, new SimAdapter(sim, SETUP, {}), 0);
    stats.handle([{ type: 'hit', id: 2, by: 1, damage: 80, at: { x: 0, z: 0 } }]);
    ents.splice(1, 1);
    stats.handle([{ type: 'died', id: 2, killer: 1 }, { type: 'removed', id: 2 }]);
    const [a, b] = stats.all();
    expect(a).toMatchObject({ kills: 1, damageDealt: 80, unitsLost: 0 });
    expect(b).toMatchObject({ kills: 0, unitsLost: 1 });
  });
});

describe('SimAdapter', () => {
  const players: PlayerState[] = [
    { id: 0, supply: 500, power: 5, morale: 900, defeated: false },
    { id: 1, supply: 0, power: 0, morale: 400, defeated: false },
    { id: 2, supply: 0, power: 0, morale: 400, defeated: true },
  ];

  it('groups morale per team', () => {
    const a = new SimAdapter(fakeSim([], players), SETUP, {});
    const t = a.teamMorale();
    expect(t.map((x) => [x.team, x.morale, x.players.length, x.defeated])).toEqual([
      [0, 900, 1, false],
      [1, 400, 2, false],
    ]);
  });

  it('blocks placement on structures and outside the map, not on units', () => {
    const ents = [unit(1, 0), unit(5, 0, 'barracks', 'structure')];
    const a = new SimAdapter(fakeSim(ents, players), SETUP, {});
    expect(a.canPlace('power_plant', { x: 10, z: 0 }, 600)).toBe(true);
    expect(a.canPlace('power_plant', { x: 52, z: 0 }, 600)).toBe(false);
    expect(a.canPlace('power_plant', { x: 295, z: 0 }, 600)).toBe(false);
  });

  it('reports economy with fallbacks', () => {
    const a = new SimAdapter(fakeSim([unit(1, 0), unit(2, 0, 'rifleman')], players), SETUP, { rifleman: { name: 'Rifleman', model: '', domain: 'ground', armor: 'infantry', hp: 100, speed: 4, turnRate: 6, radius: 0.6, sight: 70, cost: 30, buildSeconds: 5 } });
    const eco = a.economy(0);
    expect(eco.supply).toBe(500);
    expect(eco.power).toBeNull();
    expect(eco.netPower).toBe(5);
    // Rifleman costs 1 CP; the tank has no def here, so it falls back to 1.
    expect(eco.commandPoints.used).toBe(2);
  });
});
