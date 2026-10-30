import { describe, expect, it } from 'vitest';
import rules from '../data/rules.json';
import structures from '../data/structures.json';
import type { PlayerCommand } from '../src/shared/commands';
import type { SimEvent } from '../src/shared/events';
import { NEUTRAL, SIM_HZ } from '../src/shared/types';
import { FOG_UNEXPLORED, FOG_VISIBLE } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import type { Entity } from '../src/sim/world';
import { flatContent, setupFor, testContent, twoPlayers } from './fixtures';

function run(sim: Simulation, ticks: number, cmds: PlayerCommand[] = []): SimEvent[] {
  const all: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) all.push(...sim.step(t === 0 ? cmds : []));
  return all;
}

function units(sim: Simulation, owner: number, type?: string): Entity[] {
  return [...sim.world.entities.values()].filter((e) => e.owner === owner && e.kind === 'unit' && (!type || e.type === type));
}

function clear(sim: Simulation): void {
  for (const e of [...sim.world.entities.values()]) if (e.kind === 'unit') sim.world.remove(e.id);
}

describe('pathing', () => {
  it('routes a ground unit around a wall instead of through it', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    clear(sim);
    // Wall: rect centered (-60, 70), 70 wide in x, 8 deep in z. Start north of it, goal south.
    const u = sim.world.spawnUnit('jeep', 0, { x: -60, z: 90 }, 0);
    const goal = { x: -60, z: 50 };
    let maxDetour = 0;
    for (let t = 0; t < 40 * SIM_HZ; t++) {
      sim.step(t === 0 ? [{ player: 0, cmd: { type: 'move', units: [u.id], target: goal } }] : []);
      expect(sim.world.nav.passableAt(u.pos, 'ground')).toBe(true);
      maxDetour = Math.max(maxDetour, Math.abs(u.pos.x + 60));
      if (!u.order) break;
    }
    expect(Math.hypot(u.pos.x - goal.x, u.pos.z - goal.z)).toBeLessThan(2);
    expect(maxDetour).toBeGreaterThan(30); // went around an end of the 70 m wall
  });

  it('keeps naval units on water and ground units off it', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    clear(sim);
    const boat = sim.world.spawnUnit('patrol_boat', 0, { x: 270, z: 0 }, 0);
    const tank = sim.world.spawnUnit('tank_mbt', 0, { x: 200, z: 0 }, 0);
    run(sim, 30 * SIM_HZ, [
      { player: 0, cmd: { type: 'move', units: [boat.id], target: { x: 0, z: 0 } } },
      { player: 0, cmd: { type: 'move', units: [tank.id], target: { x: 290, z: 0 } } },
    ]);
    expect(sim.world.nav.passableAt(boat.pos, 'naval')).toBe(true);
    expect(sim.world.nav.passableAt(tank.pos, 'ground')).toBe(true);
    expect(boat.pos.x).toBeGreaterThan(235);
    expect(tank.pos.x).toBeLessThan(242);
  });

  it('separates a crowd without overlaps', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push(sim.world.spawnUnit('rifleman', 0, { x: (i % 5) * 0.1, z: Math.floor(i / 5) * 0.1 }, 0).id);
    run(sim, 10 * SIM_HZ, [{ player: 0, cmd: { type: 'stop', units: ids } }]);
    const us = units(sim, 0);
    let overlaps = 0;
    for (let i = 0; i < us.length; i++)
      for (let j = i + 1; j < us.length; j++) if (Math.hypot(us[i].pos.x - us[j].pos.x, us[i].pos.z - us[j].pos.z) < 0.9) overlaps++;
    expect(overlaps).toBe(0);
  });
});

describe('combat', () => {
  it('idle units auto-engage enemies in range and kill them', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const tank = sim.world.spawnUnit('tank_mbt', 0, { x: 0, z: 0 }, 0);
    const jeep = sim.world.spawnUnit('jeep', 1, { x: 0, z: 60 }, Math.PI);
    sim.step([]);
    const events = run(sim, 30 * SIM_HZ);
    expect(events.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(true);
    expect(events.some((e) => e.type === 'hit' && e.id === jeep.id)).toBe(true);
    const died = events.findIndex((e) => e.type === 'died' && e.id === jeep.id);
    expect(died).toBeGreaterThanOrEqual(0);
    expect(events[died + 1]).toEqual({ type: 'removed', id: jeep.id });
    expect(sim.get(jeep.id)).toBeUndefined();
    expect(tank.turretHeading).toBeDefined();
  });

  it('applies directional armor: rear hits hurt more than front hits', () => {
    const hit = (fromZ: number) => {
      const sim = new Simulation(twoPlayers(), flatContent());
      clear(sim);
      const target = sim.world.spawnUnit('tank_mbt', 1, { x: 0, z: 0 }, 0); // faces +z
      sim.world.spawnUnit('at_soldier', 0, { x: 0, z: fromZ }, 0);
      const ev = run(sim, 10 * SIM_HZ, [{ player: 1, cmd: { type: 'hold', units: [target.id] } }]);
      return ev.find((e) => e.type === 'hit' && e.id === target.id) as Extract<SimEvent, { type: 'hit' }>;
    };
    const front = hit(40);
    const rear = hit(-40);
    expect(rear.damage / front.damage).toBeCloseTo(1.5 / 0.6, 5);
  });

  it('attack order chases a target; hold position never moves', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const a = sim.world.spawnUnit('jeep', 0, { x: 0, z: 0 }, 0);
    const h = sim.world.spawnUnit('jeep', 0, { x: 20, z: 0 }, 0);
    const t = sim.world.spawnUnit('tank_mbt', 1, { x: 0, z: 200 }, 0);
    run(sim, 10 * SIM_HZ, [
      { player: 0, cmd: { type: 'attack', units: [a.id], targetId: t.id } },
      { player: 0, cmd: { type: 'hold', units: [h.id] } },
      { player: 1, cmd: { type: 'hold', units: [t.id] } },
    ]);
    expect(a.pos.z).toBeGreaterThan(120);
    expect(h.pos).toEqual({ x: 20, z: 0 });
  });

  it('attack-move stops to fight then continues', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const tanks = [0, 1, 2].map((i) => sim.world.spawnUnit('tank_mbt', 0, { x: i * 8, z: 0 }, 0));
    const enemy = sim.world.spawnUnit('rifleman', 1, { x: 8, z: 100 }, 0);
    const ev = run(sim, 60 * SIM_HZ, [{ player: 0, cmd: { type: 'move', units: tanks.map((t) => t.id), target: { x: 8, z: 200 }, attackMove: true } }]);
    expect(ev.some((e) => e.type === 'died' && e.id === enemy.id)).toBe(true);
    for (const t of tanks) expect(t.pos.z).toBeGreaterThan(190);
  });

  it('indirect fire announces its target point and splashes', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const arty = sim.world.spawnUnit('artillery', 0, { x: 0, z: 0 }, 0);
    sim.world.spawnUnit('jeep', 0, { x: 0, z: 150 }, 0); // spotter
    const t = sim.world.spawnUnit('rifleman', 1, { x: 0, z: 200 }, 0);
    let incoming = 0;
    let impacts = 0;
    for (let i = 0; i < 20 * SIM_HZ; i++) {
      const ev = sim.step(i === 0 ? [{ player: 1, cmd: { type: 'hold', units: [t.id] } }] : []);
      incoming += sim.proposedEvents.filter((e) => e.type === 'incoming' && e.by === arty.id).length;
      impacts += ev.filter((e) => e.type === 'impact' && e.weapon === 'howitzer').length;
    }
    expect(incoming).toBeGreaterThan(0);
    expect(impacts).toBeGreaterThan(0);
  });

  it('air-only weapons ignore ground units; AA kills helicopters', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const aa = sim.world.spawnUnit('aa_tank', 0, { x: 0, z: 0 }, 0);
    const ground = sim.world.spawnUnit('jeep', 1, { x: 0, z: 40 }, 0);
    const heli = sim.world.spawnUnit('heli_transport', 1, { x: 30, z: 60 }, 0);
    const ev = run(sim, 40 * SIM_HZ, [{ player: 1, cmd: { type: 'hold', units: [ground.id, heli.id] } }]);
    expect(ev.some((e) => e.type === 'hit' && e.id === ground.id && e.by === aa.id)).toBe(false);
    expect(ev.some((e) => e.type === 'died' && e.id === heli.id)).toBe(true);
  });
});

describe('economy & production', () => {
  it('engineer builds a barracks which then produces a rifle squad to the rally point', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const eng = units(sim, 0, 'engineer')[0];
    const hq = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'hq')!;
    const at = { x: hq.pos.x + 30, z: hq.pos.z + 30 };
    const before = w.players.get(0)!.supply;
    let ev = run(sim, 2, [{ player: 0, cmd: { type: 'build', builder: eng.id, structure: 'barracks', at, rotation: 0 } }]);
    const site = [...w.entities.values()].find((e) => e.type === 'barracks')!;
    expect(site).toBeDefined();
    expect(site.buildProgress).toBeLessThan(1);
    expect(w.players.get(0)!.supply).toBeLessThan(before - 299);
    expect(w.nav.passableAt(site.pos, 'ground')).toBe(false);
    ev = run(sim, 60 * SIM_HZ);
    expect(ev.some((e) => e.type === 'built' && e.id === site.id)).toBe(true);
    expect(site.hp).toBeCloseTo(site.maxHp, 0);

    const rally = { x: hq.pos.x + 60, z: hq.pos.z };
    ev = run(sim, 30 * SIM_HZ, [
      { player: 0, cmd: { type: 'setRally', factory: site.id, at: rally } },
      { player: 0, cmd: { type: 'produce', factory: site.id, unit: 'rifleman', count: 1 } },
    ]);
    const produced = ev.filter((e) => e.type === 'produced');
    expect(produced).toHaveLength(4);
    for (const p of produced) {
      const u = w.entities.get((p as Extract<SimEvent, { type: 'produced' }>).unit)!;
      expect(Math.hypot(u.pos.x - rally.x, u.pos.z - rally.z)).toBeLessThan(10);
    }
  });

  it('rejects invalid builds and gates tech tiers', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const eng = units(sim, 0, 'engineer')[0];
    const hq = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'hq')!;
    const supply = w.players.get(0)!.supply;
    run(sim, 1, [
      { player: 0, cmd: { type: 'build', builder: eng.id, structure: 'barracks', at: hq.pos, rotation: 0 } }, // overlaps HQ
      { player: 0, cmd: { type: 'build', builder: eng.id, structure: 'barracks', at: { x: 120, z: -120 }, rotation: 0 } }, // far away
      { player: 0, cmd: { type: 'build', builder: eng.id, structure: 'airfield', at: { x: hq.pos.x + 40, z: hq.pos.z }, rotation: 0 } }, // tier 2
      { player: 0, cmd: { type: 'produce', factory: hq.id, unit: 'tank_mbt', count: 1 } }, // HQ can't make tanks
    ]);
    expect(sim.proposedEvents.filter((e) => e.type === 'blocked').map((e) => (e as { reason: string }).reason)).toEqual(['placement', 'placement', 'requirements']);
    expect(w.players.get(0)!.supply).toBeCloseTo(supply + structures.hq.income / SIM_HZ, 6);
    expect(sim.producible(hq.id)).toEqual(['engineer']);
    expect(sim.buildable(0)).not.toContain('airfield');
  });

  it('queues, cancels with refund, and respects the CP cap', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const hq = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'hq')!;
    const p = w.players.get(0)!;
    p.supply = 10000;
    run(sim, 1, [{ player: 0, cmd: { type: 'produce', factory: hq.id, unit: 'engineer', count: 3 } }]);
    expect(sim.queue(hq.id)).toHaveLength(3);
    const s = p.supply;
    run(sim, 1, [{ player: 0, cmd: { type: 'cancelProduce', factory: hq.id, index: 2 } }]);
    expect(sim.queue(hq.id)).toHaveLength(2);
    expect(p.supply).toBeGreaterThan(s + 99);
    // Fill CP so the queue stalls at 100%.
    for (let i = 0; i < rules.baseCp + 5; i++) w.spawnUnit('engineer', 0, { x: -200, z: 200 - i }, 0);
    const ev = run(sim, 30 * SIM_HZ);
    expect(ev.some((e) => e.type === 'produced')).toBe(false);
    expect(sim.queue(hq.id)[0].progress).toBe(1);
  });

  it('power shortage halves production speed; plants restore it', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const hq = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'hq')!;
    w.spawnStructure('radar', 0, { x: hq.pos.x + 30, z: hq.pos.z - 30 }, 0, true);
    sim.step([]);
    expect(sim.economy(0)!.power).toBe(20 - 30);
    expect(sim.economy(0)!.tier).toBe(2);
    run(sim, 2 * SIM_HZ, [{ player: 0, cmd: { type: 'produce', factory: hq.id, unit: 'engineer', count: 1 } }]);
    expect(sim.queue(hq.id)[0].progress).toBeCloseTo(0.1, 1);
  });
});

describe('capture points & victory', () => {
  it('captures a neutral point, then the enemy must neutralize it first', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    clear(sim);
    const w = sim.world;
    const pt = [...w.entities.values()].find((e) => e.kind === 'point' && e.pos.x === 0 && e.pos.z === 0)!;
    const mine = [0, 1, 2].map((i) => w.spawnUnit('rifleman', 0, { x: 5 + i * 2, z: 5 }, 0));
    let ev = run(sim, 25 * SIM_HZ);
    expect(ev).toContainEqual({ type: 'captured', point: pt.id, by: 0 });
    expect(sim.capture(pt.id)!.owner).toBe(0);
    expect(sim.economy(0)!.pointsHeld).toBe(1);
    for (const u of mine) w.remove(u.id);
    // Two enemy jeeps on hold: neutralize (progress → 0) then capture.
    const enemy = [0, 1].map((i) => w.spawnUnit('jeep', 1, { x: -5 - i * 5, z: -5 }, 0));
    sim.step([{ player: 1, cmd: { type: 'hold', units: enemy.map((e) => e.id) } }]);
    ev = run(sim, 60 * SIM_HZ);
    expect(sim.proposedEvents).toBeDefined();
    expect(ev).toContainEqual({ type: 'captured', point: pt.id, by: 1 });
    expect(pt.owner).toBe(1);
  });

  it('a contested point does not move', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    clear(sim);
    const w = sim.world;
    const pt = [...w.entities.values()].find((e) => e.kind === 'point')!;
    const a = w.spawnUnit('tank_mbt', 0, { x: pt.pos.x + 5, z: pt.pos.z }, 0);
    const b = w.spawnUnit('tank_mbt', 1, { x: pt.pos.x - 5, z: pt.pos.z }, 0);
    // Make them harmless to each other so the contest lasts.
    a.weapons = [];
    b.weapons = [];
    run(sim, 10 * SIM_HZ);
    expect(pt.captureProgress).toBe(0);
    expect(pt.owner).toBe(NEUTRAL);
  });

  it('the team holding fewer points bleeds tickets and loses at zero', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    const pts = [...w.entities.values()].filter((e) => e.kind === 'point');
    for (const p of pts.slice(0, 3)) {
      p.owner = 0;
      p.team = 0;
      p.captureProgress = 1;
    }
    run(sim, 10 * SIM_HZ);
    expect(w.teams.get(0)!.tickets).toBe(1000);
    expect(w.teams.get(1)!.tickets).toBeCloseTo(1000 - 0.12 * 3 * 10, 3);
    expect(sim.player(1)!.tickets).toBeCloseTo(w.teams.get(1)!.tickets, 6);
    w.teams.get(1)!.tickets = 0.01;
    const ev = run(sim, 5);
    expect(ev).toContainEqual({ type: 'defeated', player: 1 });
    expect(ev.find((e) => e.type === 'victory')).toMatchObject({ type: 'victory', team: 0 });
    expect(sim.winner).toBe(0);
  });

  it('destroying the HQ defeats a player; FFA continues until one remains', () => {
    const sim = new Simulation(setupFor([0, 1, 2]), testContent());
    const w = sim.world;
    const hq1 = [...w.entities.values()].find((e) => e.owner === 1 && e.type === 'hq')!;
    hq1.hp = 0;
    hq1.dead = true;
    let ev = run(sim, 2);
    expect(ev).toContainEqual({ type: 'defeated', player: 1 });
    expect(ev.some((e) => e.type === 'victory')).toBe(false);
    expect(units(sim, 1)).toHaveLength(0);
    sim.step([{ player: 2, cmd: { type: 'surrender' } }]);
    ev = run(sim, 1);
    expect(sim.winner).toBe(0);
  });

  it('annihilation: losing every production building loses the game', () => {
    const sim = new Simulation(twoPlayers('annihilation'), testContent());
    const w = sim.world;
    const hq1 = [...w.entities.values()].find((e) => e.owner === 1 && e.type === 'hq')!;
    // Tickets don't matter in annihilation.
    w.teams.get(1)!.tickets = -50;
    run(sim, 5);
    expect(w.players.get(1)!.defeated).toBe(false);
    hq1.dead = true;
    const ev = run(sim, 2);
    expect(ev).toContainEqual({ type: 'defeated', player: 1 });
  });

  it('sudden death starts at 90 minutes and weakens HQs', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    w.tick = 90 * 60 * SIM_HZ;
    sim.step([]);
    expect(w.suddenDeath).toBe(true);
    expect(sim.proposedEvents.some((e) => e.type === 'suddenDeath')).toBe(true);
    const t0 = w.teams.get(0)!.tickets;
    run(sim, SIM_HZ);
    expect(w.teams.get(0)!.tickets).toBeCloseTo(t0 - 0.5, 3);
  });
});

describe('fog of war', () => {
  it('reveals around own units, keeps explored shroud, hides distant enemies', () => {
    const sim = new Simulation(twoPlayers(), flatContent());
    clear(sim);
    const w = sim.world;
    const scout = w.spawnUnit('jeep', 0, { x: 0, z: 0 }, 0);
    const enemy = w.spawnUnit('rifleman', 1, { x: 0, z: 250 }, 0);
    run(sim, 5, [{ player: 1, cmd: { type: 'hold', units: [enemy.id] } }]);
    expect(sim.fog.isVisible(0, 0, 0)).toBe(true);
    expect(sim.fog.canSee(0, enemy.id)).toBe(false);
    expect(sim.fog.canSee(1, enemy.id)).toBe(true);
    const cells = sim.fog.cells(0);
    expect(cells.length).toBe(sim.fog.cols * sim.fog.rows);
    expect(cells.includes(FOG_UNEXPLORED)).toBe(true);
    expect(cells.includes(FOG_VISIBLE)).toBe(true);
    run(sim, 20 * SIM_HZ, [{ player: 0, cmd: { type: 'move', units: [scout.id], target: { x: 0, z: 150 } } }]);
    expect(sim.fog.canSee(0, enemy.id)).toBe(true);
    expect(sim.fog.isExplored(0, 0, 0)).toBe(true);
    expect(sim.fog.isVisible(0, 0, -10)).toBe(false);
  });
});
