import type { IconId } from './icons';
import type { KeyValueStore } from './settings';

// Career record and medals, kept in this browser (localStorage). Nothing leaves the machine.

export interface MatchRecord {
  /** ISO timestamp. */
  at: string;
  mapId: string;
  mapName: string;
  mode: string;
  /** null = draw / abandoned. */
  won: boolean | null;
  durationSec: number;
  kills: number;
  lost: number;
  produced: number;
  built: number;
  captures: number;
  damage: number;
  /** Hardest AI on the other side, if any. */
  vsAi?: 'easy' | 'normal' | 'hard';
  players: number;
  /** Medals first earned in this match. */
  medals?: string[];
}

export interface CareerRecord {
  version: 1;
  matches: number;
  wins: number;
  losses: number;
  kills: number;
  lost: number;
  produced: number;
  built: number;
  captures: number;
  damage: number;
  playSeconds: number;
  longestSec: number;
  fastestWinSec: number | null;
  bestKills: number;
  tutorialDone: boolean;
  /** Medal id → ISO date earned. */
  achievements: Record<string, string>;
  /** Most recent first, capped. */
  history: MatchRecord[];
}

/** What happened in one match from the local player's side, for medals. */
export interface MatchFacts {
  won: boolean | null;
  durationSec: number;
  mode: string;
  vsAi?: 'easy' | 'normal' | 'hard';
  coop: boolean;
  kills: number;
  structuresLost: number;
  /** Lowest own-team Morale as a fraction of the start. */
  minMoraleFrac: number;
  domains: Set<string>;
  linesFormed: number;
  missiles: number;
  maxRank: number;
  heldAllPoints: boolean;
  tutorial?: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  icon: IconId;
  test(f: MatchFacts): boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'graduate', name: 'Basic training', desc: 'Finish the tutorial.', icon: 'tutorial', test: (f) => !!f.tutorial },
  { id: 'first_win', name: 'First victory', desc: 'Win a match.', icon: 'trophy', test: (f) => f.won === true && !f.tutorial },
  { id: 'hard_target', name: 'Hard target', desc: 'Defeat a Hard AI.', icon: 'skull', test: (f) => f.won === true && f.vsAi === 'hard' },
  { id: 'comeback', name: 'Back from the brink', desc: 'Win after your Morale fell below 25%.', icon: 'morale', test: (f) => f.won === true && f.minMoraleFrac < 0.25 },
  { id: 'iron_wall', name: 'Iron wall', desc: 'Win without losing a single structure.', icon: 'hold', test: (f) => f.won === true && f.structuresLost === 0 && !f.tutorial },
  { id: 'blitz', name: 'Blitz', desc: 'Win in under 20 minutes.', icon: 'sprint', test: (f) => f.won === true && f.durationSec < 20 * 60 && !f.tutorial },
  { id: 'long_war', name: 'Long war', desc: 'Fight a match past the hour mark.', icon: 'clock', test: (f) => f.durationSec >= 3600 },
  { id: 'combined_arms', name: 'Combined arms', desc: 'Field ground, air and naval units in one match.', icon: 'army', test: (f) => f.domains.has('ground') && f.domains.has('air') && f.domains.has('naval') },
  { id: 'hold_the_line', name: 'Hold the line', desc: 'Form three frontlines in one match.', icon: 'line', test: (f) => f.linesFormed >= 3 },
  { id: 'strategic_strike', name: 'Strategic strike', desc: 'Launch a cruise missile.', icon: 'missile', test: (f) => f.missiles > 0 },
  { id: 'hero', name: 'Hero of the front', desc: 'Promote a unit to Hero (rank 3).', icon: 'medal', test: (f) => f.maxRank >= 3 },
  { id: 'total_control', name: 'Total control', desc: 'Hold every strategic point at once.', icon: 'point', test: (f) => f.heldAllPoints },
  { id: 'centurion', name: 'Centurion', desc: 'Destroy 100 enemy units in one match.', icon: 'attack', test: (f) => f.kills >= 100 },
  { id: 'brothers', name: 'Brothers in arms', desc: 'Win a shared-command co-op match.', icon: 'team', test: (f) => f.won === true && f.coop },
  { id: 'online_win', name: 'Peer to peer', desc: 'Win an online match.', icon: 'globe', test: (f) => f.won === true && f.mode === 'online' },
];

const KEY = 'frontline.record.v1';
const HISTORY_MAX = 40;

export function emptyRecord(): CareerRecord {
  return { version: 1, matches: 0, wins: 0, losses: 0, kills: 0, lost: 0, produced: 0, built: 0, captures: 0, damage: 0, playSeconds: 0, longestSec: 0, fastestWinSec: null, bestKills: 0, tutorialDone: false, achievements: {}, history: [] };
}

function storage(): KeyValueStore | null {
  try {
    const s = globalThis.localStorage;
    s.getItem(KEY);
    return s;
  } catch {
    return null;
  }
}

export function loadRecord(store: KeyValueStore | null = storage()): CareerRecord {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return emptyRecord();
    const r = JSON.parse(raw) as Partial<CareerRecord>;
    if (r.version !== 1) return emptyRecord();
    return { ...emptyRecord(), ...r, achievements: { ...(r.achievements ?? {}) }, history: Array.isArray(r.history) ? r.history.slice(0, HISTORY_MAX) : [] };
  } catch {
    return emptyRecord();
  }
}

export function saveRecord(r: CareerRecord, store: KeyValueStore | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify(r));
  } catch {
    // Storage blocked or full: the record lives for this session only.
  }
}

/**
 * Add a finished match to the career and award medals. Returns the updated record and the medals
 * earned for the first time. Tutorial runs only count toward the tutorial medal.
 */
export function recordMatch(prev: CareerRecord, m: Omit<MatchRecord, 'medals'>, facts: MatchFacts, now = new Date().toISOString()): { record: CareerRecord; newMedals: Achievement[] } {
  const r: CareerRecord = { ...prev, achievements: { ...prev.achievements }, history: [...prev.history] };
  const newMedals = ACHIEVEMENTS.filter((a) => !r.achievements[a.id] && a.test(facts));
  for (const a of newMedals) r.achievements[a.id] = now;
  if (facts.tutorial) {
    r.tutorialDone = true;
    return { record: r, newMedals };
  }
  r.matches++;
  if (m.won === true) r.wins++;
  else if (m.won === false) r.losses++;
  r.kills += m.kills;
  r.lost += m.lost;
  r.produced += m.produced;
  r.built += m.built;
  r.captures += m.captures;
  r.damage += m.damage;
  r.playSeconds += m.durationSec;
  r.longestSec = Math.max(r.longestSec, m.durationSec);
  if (m.won === true) r.fastestWinSec = r.fastestWinSec === null ? m.durationSec : Math.min(r.fastestWinSec, m.durationSec);
  r.bestKills = Math.max(r.bestKills, m.kills);
  r.history.unshift({ ...m, medals: newMedals.map((a) => a.id) });
  r.history.length = Math.min(r.history.length, HISTORY_MAX);
  return { record: r, newMedals };
}
