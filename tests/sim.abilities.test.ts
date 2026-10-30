import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/shared/events';
import { SIM_HZ } from '../src/shared/types';
import type { AnyPlayerCommand, ProposedEvent } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import { flatContent, setupFor, testContent, twoPlayers } from './fixtures';

interface Log {
  events: SimEvent[];
  proposed: ProposedEvent[];
}

function run(sim: Simulation, ticks: number, cmds: AnyPlayerCommand[] = []): Log {
  const log: Log = { events: [], proposed: [] };
  for (let t = 0; t < ticks; t++) {
    log.events.push(...sim.step(t === 0 ? cmds : []));
    log.proposed.push(...sim.proposedEvents);
  }
  return log;
}

function clear(sim: Simulation): void {
  for (const e of [...sim.world.entities.values()]) if (e.kind === 'unit') sim.world.remove(e.id);
}

function flat(): Simulation {
  const sim = new Simulation(twoPlayers(), flatContent());
  clear(sim);
  return sim;
}

describe('abilities', () => {
  it('smoke blocks targeting through it until it clears', () => {
    const sim = flat();
    const w = sim.world;
    const tank = w.spawnUnit('tank_mbt', 1, { x: 0, z: 0 }, 0);
    const squad = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: -3 + i * 2, z: 70 }, Math.PI));
    const ids = squad.map((u) => u.id);
    sim.step([
      { player: 1, cmd: { type: 'hold', units: [tank.id] } },
      { player: 0, cmd: { type: 'hold', units: ids } },
      { player: 0, cmd: { type: 'useAbility', units: ids, ability: 'smoke', at: { x: 0, z: 40 } } },
    ]);
    expect(sim.proposedEvents.filter((e) => e.type === 'smoke')).toHaveLength(1); // one caster for the group
    const cooling = ids.filter((id) => sim.abilities(id).find((a) => a.ability === 'smoke')!.cooldown > 0);
    expect(cooling).toHaveLength(1);
    const during = run(sim, 15 * SIM_HZ);
    expect(during.events.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(false);
    const after = run(sim, 10 * SIM_HZ);
    expect(after.events.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(true);
  });

  it('entrench: deploys, takes less damage, packs up before moving', () => {
    const sim = flat();
    const w = sim.world;
    const u = w.spawnUnit('rifleman', 0, { x: 0, z: 0 }, 0);
    const log = run(sim, 4 * SIM_HZ, [{ player: 0, cmd: { type: 'useAbility', units: [u.id], ability: 'entrench' } }]);
    expect(log.proposed.filter((e) => e.type === 'entrench').map((e) => (e as { state: string }).state)).toEqual(['deploying', 'entrenched']);
    expect(u.entrench).toBe('entrenched');
    const tank = w.spawnUnit('tank_mbt', 1, { x: 0, z: 50 }, Math.PI);
    tank.weapons = tank.weapons.filter((wp) => wp.id === 'coax_mg');
    const hits = run(sim, 5 * SIM_HZ, [{ player: 1, cmd: { type: 'hold', units: [tank.id] } }]).events.filter(
      (e) => e.type === 'hit' && e.id === u.id && e.by === tank.id,
    ) as Extract<SimEvent, { type: 'hit' }>[];
    expect(hits.length).toBeGreaterThan(0);
    // coax_mg small_arms vs infantry = 8 * 1.0, times 0.6 entrenched.
    expect(hits.some((h) => Math.abs(h.damage - 8 * 0.6) < 1e-9)).toBe(true);
    w.remove(tank.id);
    u.hp = u.maxHp;
    const start = { ...u.pos };
    run(sim, SIM_HZ, [{ player: 0, cmd: { type: 'move', units: [u.id], target: { x: 0, z: -50 } } }]);
    expect(u.entrench).toBe('packing');
    expect(u.pos).toEqual(start);
    run(sim, 3 * SIM_HZ);
    expect(u.entrench).toBe('none');
    expect(u.pos.z).toBeLessThan(start.z - 1);
  });

  it('sprint boosts speed for its duration', () => {
    const travel = (sprint: boolean) => {
      const sim = flat();
      const u = sim.world.spawnUnit('rifleman', 0, { x: 0, z: 0 }, 0);
      const cmds: AnyPlayerCommand[] = [{ player: 0, cmd: { type: 'move', units: [u.id], target: { x: 0, z: 200 } } }];
      if (sprint) cmds.push({ player: 0, cmd: { type: 'useAbility', units: [u.id], ability: 'sprint' } });
      run(sim, 4 * SIM_HZ, cmds);
      return u.pos.z;
    };
    expect(travel(true) / travel(false)).toBeCloseTo(1.5, 1);
  });

  it('barrage needs vision, costs supply and drops a spread of shells', () => {
    const sim = flat();
    const w = sim.world;
    const arty = w.spawnUnit('artillery', 0, { x: 0, z: 0 }, 0);
    const p = w.players.get(0)!;
    // No spotter near the target: refused.
    let log = run(sim, 2, [{ player: 0, cmd: { type: 'useAbility', units: [arty.id], ability: 'barrage', at: { x: 0, z: 250 } } }]);
    expect(log.proposed).toContainEqual({ type: 'blocked', player: 0, reason: 'requirements' });
    w.spawnUnit('jeep', 0, { x: 0, z: 200 }, 0);
    run(sim, 5);
    const before = p.supply;
    log = run(sim, 10 * SIM_HZ, [{ player: 0, cmd: { type: 'useAbility', units: [arty.id], ability: 'barrage', at: { x: 0, z: 250 } } }]);
    // 100 for the barrage, +20 HQ income over 10 s.
    expect(p.supply).toBeCloseTo(before - 100 + 20, 6);
    const shells = log.proposed.filter((e) => e.type === 'incoming' && e.by === arty.id) as Extract<ProposedEvent, { type: 'incoming' }>[];
    expect(shells).toHaveLength(6);
    for (const s of shells) expect(Math.hypot(s.at.x, s.at.z - 250)).toBeLessThanOrEqual(25);
    expect(log.events.filter((e) => e.type === 'impact' && e.weapon === 'howitzer').length).toBe(6);
  });

  it('ambush hides a stationary AT team until it fires, with a stronger first shot', () => {
    const sim = flat();
    const w = sim.world;
    const at = w.spawnUnit('at_soldier', 0, { x: 0, z: 0 }, 0);
    const tank = w.spawnUnit('tank_mbt', 1, { x: 0, z: 70 }, Math.PI);
    sim.step([
      { player: 0, cmd: { type: 'useAbility', units: [at.id], ability: 'ambush' } },
      { player: 0, cmd: { type: 'hold', units: [at.id] } },
      { player: 1, cmd: { type: 'hold', units: [tank.id] } },
    ]);
    expect(at.ambush).toBe(true);
    let log = run(sim, 5 * SIM_HZ);
    expect(sim.fog.canSee(1, at.id)).toBe(false);
    expect(log.events.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(false);
    // Tank drives into rocket range; the ambush springs.
    tank.pos.z = 50;
    log = run(sim, 5 * SIM_HZ);
    const first = log.events.find((e) => e.type === 'hit' && e.id === tank.id) as Extract<SimEvent, { type: 'hit' }>;
    expect(log.proposed.some((e) => e.type === 'revealed' && e.id === at.id)).toBe(true);
    // at_rocket 120 AP vs heavy 1.0, front armor 0.6, ambush x1.5.
    expect(first.damage).toBeCloseTo(120 * 0.6 * 1.5, 6);
    // Once revealed the tank returns fire.
    expect(log.events.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(true);
  });

  it('point abilities walk into range first', () => {
    const sim = flat();
    const u = sim.world.spawnUnit('rifleman', 0, { x: 0, z: 0 }, 0);
    const log = run(sim, 30 * SIM_HZ, [{ player: 0, cmd: { type: 'useAbility', units: [u.id], ability: 'smoke', at: { x: 0, z: 120 } } }]);
    const used = log.proposed.find((e) => e.type === 'abilityUsed');
    expect(used).toMatchObject({ type: 'abilityUsed', id: u.id, ability: 'smoke' });
    expect(u.pos.z).toBeGreaterThan(55);
  });
});

describe('logistics', () => {
  it('a held point sends a truck that hauls supply to the HQ', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const hq = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'hq')!;
    const pt = [...w.entities.values()].find((e) => e.kind === 'point' && e.pos.x === -170)!;
    pt.owner = 0;
    pt.team = 0;
    pt.captureProgress = 1;
    const p = w.players.get(0)!;
    const before = p.supply;
    const log = run(sim, 90 * SIM_HZ);
    const truck = log.events.find((e) => e.type === 'spawned' && w.entities.get(e.id)?.type === 'supply_truck');
    expect(truck).toBeDefined();
    const delivered = log.proposed.filter((e) => e.type === 'delivered') as Extract<ProposedEvent, { type: 'delivered' }>[];
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered[0].amount).toBeGreaterThanOrEqual(50);
    // HQ trickle alone over 90 s would be 180.
    expect(p.supply - before).toBeGreaterThan(180 + 49);
    expect(Math.hypot(hq.pos.x, hq.pos.z)).toBeGreaterThan(0);
  });

  it('killing the truck cuts the line until a replacement arrives', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const pt = [...w.entities.values()].find((e) => e.kind === 'point' && e.pos.x === -170)!;
    pt.owner = 0;
    pt.team = 0;
    pt.captureProgress = 1;
    run(sim, 5);
    const truck = w.entities.get(pt.truck)!;
    expect(truck.type).toBe('supply_truck');
    truck.dead = true;
    run(sim, 2);
    expect(pt.truck).toBe(0);
    expect(pt.truckReadyAt).toBeGreaterThan(w.tick + 25 * SIM_HZ);
    // Trucks can't be commanded by players.
    run(sim, 30 * SIM_HZ);
    const t2 = w.entities.get(pt.truck)!;
    expect(t2.type).toBe('supply_truck');
    const z = t2.pos.z;
    run(sim, 10, [{ player: 0, cmd: { type: 'stop', units: [t2.id] } }]);
    expect(t2.pos.z).not.toBe(z);
  });

  it('units far from supply lose readiness and fire slower', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const home = w.spawnUnit('jeep', 0, { x: -120, z: 90 }, 0);
    const far = w.spawnUnit('jeep', 0, { x: 200, z: 250 }, 0);
    run(sim, 60 * SIM_HZ);
    expect(sim.readiness(home.id)).toBe(1);
    expect(sim.readiness(far.id)).toBeCloseTo(1 - 60 * 0.005, 6);
    far.readiness = 0.5;
    const enemy = w.spawnUnit('jeep', 1, { x: 200, z: 210 }, 0);
    enemy.hp = 1e9;
    enemy.maxHp = 1e9;
    run(sim, 3 * SIM_HZ, [{ player: 1, cmd: { type: 'hold', units: [enemy.id] } }]);
    // jeep_mg reload 0.25 s = 5 ticks; at readiness 0.5 it is 10.
    expect(far.weapons[0].cooldown).toBeLessThanOrEqual(10);
    let max = 0;
    for (let i = 0; i < 40; i++) {
      sim.step([]);
      max = Math.max(max, far.weapons[0].cooldown);
    }
    expect(max).toBe(10);
  });
});

describe('shared command (co-op hook)', () => {
  const coop = (shared: boolean) => {
    const s = setupFor([0, 0, 1]);
    if (shared) (s.players[1] as { commandsFor?: number[] }).commandsFor = [0];
    return s;
  };

  it('only the owner may command by default', () => {
    const sim = new Simulation(coop(false), testContent());
    const u = [...sim.world.entities.values()].find((e) => e.owner === 0 && e.type === 'rifleman')!;
    const start = { ...u.pos };
    run(sim, 5 * SIM_HZ, [{ player: 1, cmd: { type: 'move', units: [u.id], target: { x: 0, z: 0 } } }]);
    expect(u.pos).toEqual(start);
    expect(sim.canCommand(1, u.id)).toBe(false);
  });

  it('a co-commander moves the shared army and spends the owner’s supply', () => {
    const sim = new Simulation(coop(true), testContent());
    const w = sim.world;
    const u = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'rifleman')!;
    const hq0 = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'hq')!;
    expect(sim.canCommand(1, u.id)).toBe(true);
    expect(sim.canCommand(0, [...w.entities.values()].find((e) => e.owner === 1 && e.type === 'hq')!.id)).toBe(false);
    const s0 = w.players.get(0)!.supply;
    const s1 = w.players.get(1)!.supply;
    run(sim, 5 * SIM_HZ, [
      { player: 1, cmd: { type: 'move', units: [u.id], target: { x: 0, z: 0 } } },
      { player: 1, cmd: { type: 'produce', factory: hq0.id, unit: 'engineer', count: 1 } },
    ]);
    expect(Math.hypot(u.pos.x - -120, u.pos.z - 120)).toBeGreaterThan(10);
    expect(w.players.get(0)!.supply).toBeCloseTo(s0 - 100 + 10, 6);
    expect(w.players.get(1)!.supply).toBeGreaterThan(s1);
  });
});
