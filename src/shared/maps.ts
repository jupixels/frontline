// Pure helpers over MapDef that every module must agree on (sim spawns players with these, the
// renderer and UI point the camera with them).

import type { MapDef } from './data';
import type { PlayerId, PlayerSlot } from './types';

/**
 * Spawn index for every player. Team games use the map's `sides` so teammates start together;
 * free-for-all and maps without sides take the spawns in order (players sorted by id).
 */
export function assignSpawns(map: Pick<MapDef, 'spawns' | 'sides'>, players: readonly Pick<PlayerSlot, 'id' | 'team'>[]): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  const sorted = [...players].sort((a, b) => a.id - b.id);
  const teams: number[] = [];
  for (const p of sorted) if (!teams.includes(p.team)) teams.push(p.team);
  const sides = map.sides;
  const n = map.spawns.length;
  const used = new Set<number>();
  const teamGame = teams.length < sorted.length;
  if (sides && sides.length >= teams.length && (teamGame || teams.length === 2)) {
    teams.forEach((team, ti) => {
      const side = sides[ti];
      let k = 0;
      for (const p of sorted) {
        if (p.team !== team) continue;
        let idx = side[k++ % side.length];
        if (used.has(idx)) idx = firstFree(used, n, idx);
        used.add(idx);
        out.set(p.id, idx);
      }
    });
    return out;
  }
  for (const p of sorted) {
    let idx = p.id % n;
    if (used.has(idx)) idx = firstFree(used, n, idx);
    used.add(idx);
    out.set(p.id, idx);
  }
  return out;
}

function firstFree(used: Set<number>, n: number, from: number): number {
  for (let i = 0; i < n; i++) {
    const k = (from + i) % n;
    if (!used.has(k)) return k;
  }
  return from % n;
}
