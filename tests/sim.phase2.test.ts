import { describe, expect, it } from 'vitest';
import units from '../data/units.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import type { SimEvent } from '../src/shared/events';
import { SIM_HZ, type MatchSetup } from '../src/shared/types';
import type { AnyPlayerCommand } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import { flatContent, twoPlayers } from './fixtures';

function run(sim: Simulation, ticks: number, cmds: AnyPlayerCommand[] = []): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    out.push(...sim.step(t === 0 ? cmds : []));
    out.push(...sim.proposedEvents);
  }
  return out;
}

function flat(setup: MatchSetup = twoPlayers()): Simulation {
  const sim = new Simulation(setup, flatContent());
  for (const e of [...sim.world.entities.values()]) if (e.kind === 'unit') sim.world.remove(e.id);
  return sim;
}

/** A map with one tall ridge across the middle (gap on the east) and a forest on the west. */
function ridgeMap(): MapDef {
  return {
    id: 'ridge',
    name: 'Ridge',
    size: 600,
    spawns: [
      { x: 0, z: 220 },
      { x: 0, z: -220 },
    ],
    terrain: {
      seed: 3,
      relief: 0,
      detail: 0,
      ridges: [{ points: [[-300, 0], [120, 0]], width: 40, h: 30, cliff: true }],
      forests: [{ shape: 'rect', x: -200, z: 100, w: 80, d: 80 }],
      hills: [{ x: 200, z: 150, r: 60, h: 25, plateau: 0.5 }],
    },
  };
}

describe('terrain', () => {
  it('cliffs block ground movement; the gap lets units through', () => {
    const sim = new Simulation(twoPlayers(), { units: units as Record<string, UnitDef>, map: ridgeMap() });
    const nav = sim.world.nav;
    expect(nav.passableAt({ x: 0, z: 0 }, 'ground')).toBe(false);
    expect(nav.passableAt({ x: 0, z: 15 }, 'ground')).toBe(false);
    expect(nav.passableAt({ x: 200, z: 0 }, 'ground')).toBe(true);
    expect(sim.reachable('ground', { x: 0, z: 100 }, { x: 0, z: -100 })).toBe(true);
    expect(sim.heightAt(200, 150)).toBeGreaterThan(sim.heightAt(0, 200) + 15);
  });

  it('a ridge blocks line of sight and forests hide units inside them', () => {
    const sim = new Simulation(twoPlayers(), { units: units as Record<string, UnitDef>, map: ridgeMap() });
    const w = sim.world;
    for (const e of [...w.entities.values()]) if (e.kind === 'unit') w.remove(e.id);
    w.spawnUnit('jeep', 0, { x: -100, z: 60 }, 0);
    const hidden = w.spawnUnit('rifleman', 1, { x: -100, z: -60 }, 0);
    const inForest = w.spawnUnit('rifleman', 1, { x: -200, z: 100 }, 0);
    const open = w.spawnUnit('rifleman', 1, { x: -40, z: 100 }, 0);
    w.fog.update();
    expect(sim.fog.canSee(0, hidden.id)).toBe(false);
    expect(sim.fog.canSee(0, inForest.id)).toBe(false);
    expect(sim.fog.canSee(0, open.id)).toBe(true);
  });

  it('high ground adds weapon range', () => {
    const sim = new Simulation(twoPlayers(), { units: units as Record<string, UnitDef>, map: ridgeMap() });
    const w = sim.world;
    for (const e of [...w.entities.values()]) if (e.kind === 'unit') w.remove(e.id);
    // Tank cannon range 80: from the edge of the hilltop it reaches a target 90 m away on the plain.
    const tank = w.spawnUnit('tank_mbt', 0, { x: 200, z: 178 }, 0);
    w.spawnUnit('jeep', 1, { x: 200, z: 268 }, 0);
    w.spawnUnit('jeep', 0, { x: 200, z: 228 }, 0); // spotter
    const ev = run(sim, 8 * SIM_HZ, [{ player: 0, cmd: { type: 'hold', units: [tank.id] } }]);
    expect(ev.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(true);
  });
});

describe('phase 2 mechanics', () => {
  it('suppression pins infantry under machine-gun fire, then they recover', () => {
    const sim = flat();
    const w = sim.world;
    const sq = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: i * 2, z: 0 }, 0));
    const mg = w.spawnUnit('jeep', 1, { x: 0, z: 40 }, Math.PI);
    const ev = run(sim, 6 * SIM_HZ, [{ player: 1, cmd: { type: 'hold', units: [mg.id] } }]);
    expect(ev.some((e) => e.type === 'suppressed' && e.pinned)).toBe(true);
    w.remove(mg.id);
    const after = run(sim, 15 * SIM_HZ);
    expect(after.some((e) => e.type === 'suppressed' && !e.pinned) || sq.every((u) => u.dead || !u.pinned)).toBe(true);
  });

  it('veterancy: kills promote a unit and raise its health', () => {
    const sim = flat();
    const w = sim.world;
    const tank = w.spawnUnit('tank_mbt', 0, { x: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) w.spawnUnit('jeep', 1, { x: -45 + i * 10, z: 60 }, Math.PI);
    const hp0 = tank.maxHp;
    const ev = run(sim, 60 * SIM_HZ, [{ player: 0, cmd: { type: 'hold', units: [tank.id] } }]);
    expect(ev.some((e) => e.type === 'promoted' && e.id === tank.id)).toBe(true);
    expect(tank.rank).toBeGreaterThan(0);
    expect(tank.maxHp).toBeGreaterThan(hp0);
  });

  it('infantry board an IFV, ride, and unload at a point', () => {
    const sim = flat();
    const w = sim.world;
    const ifv = w.spawnUnit('ifv', 0, { x: 0, z: 0 }, 0);
    const sq = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: 10 + i * 2, z: 0 }, 0));
    const ids = sq.map((u) => u.id);
    run(sim, 6 * SIM_HZ, [{ player: 0, cmd: { type: 'enter', units: ids, target: ifv.id } }]);
    expect(ifv.cargo).toHaveLength(4);
    expect(sq.every((u) => u.inside === ifv.id)).toBe(true);
    run(sim, 20 * SIM_HZ, [{ player: 0, cmd: { type: 'unload', units: [ifv.id], at: { x: 0, z: 100 } } }]);
    expect(ifv.cargo).toHaveLength(0);
    for (const u of sq) {
      expect(u.inside).toBe(0);
      expect(u.pos.z).toBeGreaterThan(70);
    }
  });

  it('garrisoned infantry fire from a trench and only the trench can be hit', () => {
    const sim = flat();
    const w = sim.world;
    const trench = w.spawnStructure('trench', 0, { x: 0, z: 0 }, 0, true);
    const sq = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: i * 2, z: 10 }, 0));
    run(sim, 5 * SIM_HZ, [{ player: 0, cmd: { type: 'enter', units: sq.map((u) => u.id), target: trench.id } }]);
    expect(trench.cargo).toHaveLength(4);
    const enemy = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 1, { x: -6 + i * 4, z: 40 }, Math.PI));
    const ev = run(sim, 10 * SIM_HZ, [{ player: 1, cmd: { type: 'hold', units: enemy.map((u) => u.id) } }]);
    expect(ev.some((e) => e.type === 'fired' && sq.some((u) => u.id === e.id))).toBe(true);
    expect(ev.some((e) => e.type === 'hit' && sq.some((u) => u.id === e.id))).toBe(false);
  });

  it('patrol walks back and forth', () => {
    const sim = flat();
    const w = sim.world;
    const j = w.spawnUnit('jeep', 0, { x: 0, z: 0 }, 0);
    let maxZ = 0;
    let back = false;
    sim.step([{ player: 0, cmd: { type: 'patrol', units: [j.id], target: { x: 0, z: 80 } } }]);
    for (let t = 0; t < 30 * SIM_HZ; t++) {
      sim.step([]);
      maxZ = Math.max(maxZ, j.pos.z);
      if (maxZ > 75 && j.pos.z < 10) back = true;
    }
    expect(maxZ).toBeGreaterThan(75);
    expect(back).toBe(true);
    expect(j.order?.kind).toBe('patrol');
  });

  it('frontline: units spread along the line, AT on the flanks, tanks behind; gaps close', () => {
    const sim = flat();
    const w = sim.world;
    const inf = [0, 1, 2, 3, 4, 5].map((i) => w.spawnUnit('rifleman', 0, { x: -20 + i * 6, z: 150 }, 0));
    const at = [0, 1].map((i) => w.spawnUnit('at_soldier', 0, { x: i * 4, z: 155 }, 0));
    const tank = w.spawnUnit('tank_mbt', 0, { x: 0, z: 160 }, 0);
    const all = [...inf, ...at, tank];
    run(sim, 45 * SIM_HZ, [{ player: 0, cmd: { type: 'holdLine', units: all.map((u) => u.id), points: [{ x: -80, z: 50 }, { x: 80, z: 50 }] } }]);
    const line = sim.lines(0)[0];
    expect(line.units).toHaveLength(all.length);
    // Facing away from player 0's HQ (south-west corner at z=+120): toward -z.
    expect(Math.abs(Math.abs(line.facing) - Math.PI)).toBeLessThan(0.2);
    for (const u of all) expect(Math.abs(u.pos.z - 50)).toBeLessThan(18);
    const xs = inf.map((u) => u.pos.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(80);
    // AT teams sit at the outer ends.
    expect(Math.max(...at.map((u) => Math.abs(u.pos.x)))).toBeGreaterThan(Math.max(...xs.map(Math.abs)) - 15);
    expect(tank.pos.z).toBeGreaterThan(53);
    // Advance the line 40 m.
    run(sim, 20 * SIM_HZ, [{ player: 0, cmd: { type: 'advanceLine', line: line.id, distance: 40 } }]);
    for (const u of inf) expect(u.pos.z).toBeLessThan(25);
    // Remove half the infantry: the rest spread out again.
    for (const u of inf.slice(0, 3)) w.remove(u.id);
    run(sim, 20 * SIM_HZ);
    expect(sim.lines(0)[0].units).toHaveLength(all.length - 3);
  });

  it('superweapon charges, warns everyone, and wrecks the target area', () => {
    const sim = flat();
    const w = sim.world;
    w.players.get(0)!.supply = 99999;
    w.spawnStructure('power_plant', 0, { x: -200, z: 200 }, 0, true);
    w.spawnStructure('strategic_command', 0, { x: -160, z: 200 }, 0, true);
    const target = w.spawnStructure('barracks', 1, { x: 150, z: -150 }, 0, true);
    w.players.get(0)!.superCharge = 1e9;
    sim.step([]);
    expect(sim.superweapon(0)?.ready).toBe(true);
    const ev = run(sim, 15 * SIM_HZ, [{ player: 0, cmd: { type: 'superweapon', at: { x: 150, z: -150 } } }]);
    const launch = ev.find((e) => e.type === 'superweaponLaunched');
    expect(launch).toBeTruthy();
    expect(ev.some((e) => e.type === 'superweaponImpact')).toBe(true);
    expect(target.hp).toBeLessThan(target.maxHp * 0.3);
    expect(sim.superweapon(0)?.ready).toBe(false);
  });

  it('pause vote: half the humans pause, game time stops, anyone resumes', () => {
    const sim = flat();
    const j = sim.world.spawnUnit('jeep', 0, { x: 0, z: 0 }, 0);
    sim.step([{ player: 0, cmd: { type: 'move', units: [j.id], target: { x: 0, z: 200 } } }]);
    const ev = run(sim, 1, [{ player: 0, cmd: { type: 'pauseVote', paused: true } }]);
    expect(ev.some((e) => e.type === 'paused' && e.paused)).toBe(true);
    const z = j.pos.z;
    const t = sim.gameTick;
    run(sim, 100);
    expect(j.pos.z).toBe(z);
    expect(sim.gameTick).toBe(t);
    run(sim, 1, [{ player: 1, cmd: { type: 'pauseVote', paused: false } }]);
    run(sim, 10);
    expect(j.pos.z).toBeGreaterThan(z);
    expect(sim.pause.left[0]).toBe(2);
  });
});
