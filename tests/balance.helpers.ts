import units from '../data/units.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import { SIM_HZ, type MatchSetup } from '../src/shared/types';
import { Simulation } from '../src/sim/simulation';

const UNITS = units as unknown as Record<string, UnitDef & { cost: number; squad?: number }>;

/** An army as squads to field: [type, squads]. */
export type Army = [string, number][];

export function cost(army: Army): number {
  return army.reduce((a, [t, n]) => a + UNITS[t].cost * n, 0);
}

/** `budget` worth of one unit type (whole squads, rounded to the nearest). */
export function mono(type: string, budget: number): Army {
  return [[type, Math.max(1, Math.round(budget / UNITS[type].cost))]];
}

/** Combined arms of roughly `budget`: a fixed share per type, whole squads. */
export function mixed(budget: number, shares: Record<string, number>): Army {
  const out: Army = [];
  for (const [t, share] of Object.entries(shares)) out.push([t, Math.max(1, Math.round((budget * share) / UNITS[t].cost))]);
  return out;
}

export interface BattleResult {
  /** Fraction of each side's starting value still alive. */
  a: number;
  b: number;
  seconds: number;
}

const MAP: MapDef = { id: 'range', name: 'Range', size: 800, spawns: [{ x: 0, z: 350 }, { x: 0, z: -350 }] };
/** Open sea for naval fights (spawns on a small island at each end). */
const SEA: MapDef = { ...MAP, id: 'sea', water: [{ shape: 'rect', x: 0, z: 0, w: 800, d: 640 }] };

function setup(seed: number): MatchSetup {
  return {
    seed,
    mapId: 'range',
    victory: 'annihilation',
    players: [0, 1].map((id) => ({ id, team: id, name: `P${id}`, color: '#888', kind: 'human' as const })),
  };
}

/**
 * Two armies on open, flat ground 180 m apart attack-move into each other (with a spotter jeep
 * far behind each so indirect fire has vision). Returns surviving value fractions after the fight
 * or `maxSeconds`.
 */
export function battle(a: Army, b: Army, opts: { seed?: number; maxSeconds?: number; gap?: number } = {}): BattleResult {
  const naval = [...a, ...b].some(([t]) => UNITS[t].domain === 'naval');
  const sim = new Simulation(setup(opts.seed ?? 3), { units: UNITS, map: naval ? SEA : MAP });
  const w = sim.world;
  for (const e of [...w.entities.values()]) if (e.kind === 'unit') w.remove(e.id);
  const gap = opts.gap ?? 180;
  const value = new Map<number, number>();
  const ids: number[][] = [[], []];
  [a, b].forEach((army, side) => {
    const z0 = side === 0 ? gap / 2 : -gap / 2;
    const dir = side === 0 ? 1 : -1;
    let i = 0;
    for (const [type, squads] of army) {
      const def = UNITS[type];
      const n = squads * (def.squad ?? 1);
      for (let k = 0; k < n; k++, i++) {
        const row = Math.floor(i / 14);
        const col = (i % 14) - 6.5;
        // Long-range support starts further back, like it would in a real army.
        const back = def.domain === 'air' ? 10 : /artillery|rocket_truck/.test(type) ? 90 : 0;
        const e = w.spawnUnit(type, side, { x: col * 7, z: z0 + dir * (row * 7 + back) }, side === 0 ? Math.PI : 0);
        value.set(e.id, def.cost / (def.squad ?? 1));
        ids[side].push(e.id);
      }
    }
  });
  const start = [0, 1].map((s) => ids[s].reduce((t, id) => t + (value.get(id) ?? 0), 0));
  sim.step([
    { player: 0, cmd: { type: 'move', units: ids[0], target: { x: 0, z: -gap }, attackMove: true } },
    { player: 1, cmd: { type: 'move', units: ids[1], target: { x: 0, z: gap }, attackMove: true } },
  ]);
  const max = (opts.maxSeconds ?? 240) * SIM_HZ;
  const alive = (s: number) => ids[s].reduce((t, id) => t + (w.entities.get(id)?.dead === false ? ((value.get(id) ?? 0) * (w.entities.get(id)!.hp / w.entities.get(id)!.maxHp)) : 0), 0);
  let t = 0;
  for (; t < max; t++) {
    sim.step([]);
    if (t % SIM_HZ === 0) {
      // The fight is over when one side can no longer hurt the other (or is gone).
      const a0 = alive(0);
      const b0 = alive(1);
      if (a0 <= 0 || b0 <= 0) break;
      // Re-issue the attack every 10 s so idle units keep pushing.
      if (t % (SIM_HZ * 10) === 0) {
        const live = (s: number) => ids[s].filter((id) => w.entities.has(id));
        sim.step([
          { player: 0, cmd: { type: 'move', units: live(0), target: { x: 0, z: -gap }, attackMove: true } },
          { player: 1, cmd: { type: 'move', units: live(1), target: { x: 0, z: gap }, attackMove: true } },
        ]);
      }
    }
  }
  return { a: alive(0) / start[0], b: alive(1) / start[1], seconds: t / SIM_HZ };
}
