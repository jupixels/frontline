// Manual tuning harness: SIMRUN=1 npx vitest run tests/tools/sim-run.test.ts
import { it } from 'vitest';
import units from '../../data/units.json';
import valley from '../../data/maps/valley_pass.json';
import coastal from '../../data/maps/coastal_strait.json';
import desert from '../../data/maps/desert_oilfields.json';
import type { MapDef, UnitDef } from '../../src/shared/data';
import type { MatchSetup } from '../../src/shared/types';
import { runHeadless } from '../../src/ai/headless';

const MAPS: Record<string, MapDef> = { valley_pass: valley as unknown as MapDef, coastal_strait: coastal as unknown as MapDef, desert_oilfields: desert as unknown as MapDef };

it.skipIf(!process.env.SIMRUN)('headless match', () => {
  const base = MAPS[process.env.MAP ?? 'valley_pass'];
  // SWAP=1: player 0 starts where player 1 normally does (to tell side bias from player-order bias).
  const map = process.env.SWAP ? { ...base, spawns: [...base.spawns].reverse() } : base;
  const diffs = (process.env.AIS ?? 'normal,normal').split(',') as ('easy' | 'normal' | 'hard')[];
  const teams = process.env.TEAMS?.split(',').map(Number) ?? diffs.map((_, i) => i);
  const setup: MatchSetup = { seed: Number(process.env.SEED ?? 1), mapId: map.id, victory: 'frontline', players: diffs.map((d, id) => ({ id, team: teams[id], name: `AI${id}`, color: '#888', kind: 'ai' as const, aiDifficulty: d })) };
  const t0 = performance.now();
  const r = runHeadless(setup, { units: units as Record<string, UnitDef>, map }, { maxSeconds: Number(process.env.SECS ?? 1800), everySecond: (sim, s) => {
    if (s % 120 === 0) {
      const w = sim.world;
      const line = [...w.players.values()].map((p) => `P${p.id} sup=${Math.round(p.supply)} cp=${p.cp.toFixed(0)}/${p.cpCap} tier=${p.tier} pts=${p.pointsHeld} t=${Math.round(p.morale)}`).join(' | ');
      console.log(`${Math.floor(s / 60)}m ${line}`);
      if (process.env.VERBOSE) for (const p of w.players.values()) {
        const st: Record<string, number> = {};
        for (const e of w.entities.values()) if (e.owner === p.id && (e.kind === 'structure' || e.type === 'engineer')) st[e.type + (e.buildProgress < 1 ? '*' : '')] = (st[e.type] ?? 0) + 1;
        console.log(`   P${p.id} ${JSON.stringify(st)} power=${p.powerProduced}-${p.powerUsed}`);
      }
    }
  } });
  console.log(`winner=${r.winner} secs=${Math.round(r.seconds)} morale=${JSON.stringify(r.morale)} produced=${JSON.stringify(r.produced)} lost=${JSON.stringify(r.lost)} wall=${Math.round(performance.now() - t0)}ms`);
  console.log(JSON.stringify(r.types));
}, 600000);
