import type { ReplayFile } from '../net/replay';

// The last few finished matches, kept in this browser so they can be watched again without saving
// a file. Command logs are small (orders only), so a handful fits easily in localStorage.

export interface StoredReplay {
  id: string;
  savedAt: string;
  mapName: string;
  durationSec: number;
  players: { name: string; color: string; team: number }[];
  won: boolean | null;
  replay: ReplayFile;
}

const KEY = 'frontline.replays.v1';
const KEEP = 6;

function store(): Storage | null {
  try {
    globalThis.localStorage.getItem(KEY);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function listReplays(): StoredReplay[] {
  try {
    const raw = store()?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as StoredReplay[]) : [];
    return Array.isArray(list) ? list.filter((r) => r?.replay?.format === 'frontline-replay') : [];
  } catch {
    return [];
  }
}

function write(list: StoredReplay[]): void {
  const s = store();
  if (!s) return;
  // Drop the oldest until it fits.
  for (let n = list.length; n > 0; n--) {
    try {
      s.setItem(KEY, JSON.stringify(list.slice(0, n)));
      return;
    } catch {
      // Quota: try with fewer.
    }
  }
}

export function storeReplay(r: Omit<StoredReplay, 'id'>): StoredReplay {
  const entry: StoredReplay = { ...r, id: `${r.replay.matchId}-${r.replay.endTick}` };
  write([entry, ...listReplays().filter((x) => x.id !== entry.id)].slice(0, KEEP));
  return entry;
}

export function deleteReplay(id: string): void {
  write(listReplays().filter((x) => x.id !== id));
}
