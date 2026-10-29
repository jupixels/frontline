import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MatchSetup } from '../src/shared/types';
import type { AnyPlayerCommand, SimPlayerSlot } from '../src/sim/contracts';
import { Prng } from '../src/sim/math/prng';
import { Simulation } from '../src/sim/simulation';
import { testContent } from './fixtures';

const setup: MatchSetup = {
  seed: 1234,
  mapId: 'sandbox',
  victory: 'frontline',
  players: [0, 1, 2, 3].map((id) => ({ id, team: id, name: `P${id}`, color: '#888', kind: 'human' as const })),
};

/** Random but reproducible command stream across all four players. */
function scriptedRun(ticks: number): { hashes: number[] } {
  const sim = new Simulation(setup, testContent());
  const script = new Prng(99);
  const hashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const commands: AnyPlayerCommand[] = [];
    if (t % 15 === 0) {
      for (const p of setup.players) {
        const units = [...sim.entities()].filter((e) => e.owner === p.id && script.next() < 0.6).map((e) => e.id);
        commands.push({ player: p.id, cmd: { type: 'move', units, target: { x: script.range(-200, 200), z: script.range(-200, 200) } } });
      }
    }
    sim.step(commands);
    if (t % 50 === 0) hashes.push(sim.hash());
  }
  hashes.push(sim.hash());
  return { hashes };
}

describe('determinism', () => {
  it('produces identical hashes for identical input', () => {
    const a = scriptedRun(1200);
    const b = scriptedRun(1200);
    expect(a.hashes).toEqual(b.hashes);
    // Units actually moved, so the test is not trivially passing.
    expect(new Set(a.hashes).size).toBeGreaterThan(10);
  }, 60000);

  it('stays identical through building, production and combat', () => {
    const a = battleRun();
    const b = battleRun();
    expect(a.hashes).toEqual(b.hashes);
    expect(a.counts.built).toBeGreaterThan(0);
    expect(a.counts.produced).toBeGreaterThan(10);
    expect(a.counts.fired).toBeGreaterThan(50);
    expect(a.counts.died).toBeGreaterThan(5);
    expect(a.counts.abilityUsed).toBeGreaterThan(5);
    expect(a.counts.incoming).toBeGreaterThan(5);
  }, 60000);

  it('stays identical when two players command the same army (co-op hook)', () => {
    const shared = coopRun(true);
    expect(coopRun(true)).toEqual(shared);
    // The co-commanders' orders really took effect: without commandsFor the match differs.
    expect(coopRun(false)).not.toEqual(shared);
  }, 60000);
});

/** 2v2 where players 1 and 3 have no army of their own use and steer their partners' instead. */
function coopRun(shared: boolean): number[] {
  const s: MatchSetup = {
    ...setup,
    players: [0, 1, 2, 3].map((id): SimPlayerSlot => ({
      id,
      team: id < 2 ? 0 : 1,
      name: `P${id}`,
      color: '#888',
      kind: 'human',
      commandsFor: shared && id % 2 === 1 ? [id - 1] : undefined,
    })),
  };
  const sim = new Simulation(s, testContent());
  const w = sim.world;
  const script = new Prng(21);
  const hashes: number[] = [];
  for (let t = 0; t < 1500; t++) {
    const commands: AnyPlayerCommand[] = [];
    for (const owner of [0, 2]) {
      const army = [...w.entities.values()].filter((e) => e.owner === owner && e.kind === 'unit' && e.type === 'rifleman').map((e) => e.id);
      const hq = [...w.entities.values()].find((e) => e.owner === owner && e.type === 'hq');
      // Both the owner and the co-commander issue orders to the same units in the same turn.
      if (t % 40 === 0) commands.push({ player: owner, cmd: { type: 'move', units: army, target: { x: script.range(-60, 60), z: script.range(-60, 60) }, attackMove: true } });
      if (t % 40 === 0) commands.push({ player: owner + 1, cmd: { type: 'move', units: army.slice(0, 4), target: { x: script.range(-60, 60), z: script.range(-60, 60) } } });
      if (t % 200 === 10 && hq) commands.push({ player: owner + 1, cmd: { type: 'produce', factory: hq.id, unit: 'engineer', count: 1 } });
      if (t % 300 === 20) commands.push({ player: owner + 1, cmd: { type: 'useAbility', units: army, ability: 'sprint' } });
    }
    sim.step(commands);
    if (t % 50 === 0) hashes.push(sim.hash());
  }
  hashes.push(sim.hash());
  return hashes;
}

/**
 * Four players build barracks, queue squads, rally them to the center and attack-move into each
 * other, with extra tanks and artillery so every weapon delivery type fires.
 */
function battleRun(): { hashes: number[]; counts: Record<string, number> } {
  const sim = new Simulation(setup, testContent());
  const w = sim.world;
  const script = new Prng(7);
  const hashes: number[] = [];
  const counts: Record<string, number> = { built: 0, produced: 0, fired: 0, died: 0, abilityUsed: 0, incoming: 0, delivered: 0 };
  for (const p of setup.players) {
    w.players.get(p.id)!.supply = 5000;
    const hq = [...w.entities.values()].find((e) => e.owner === p.id && e.type === 'hq')!;
    for (const [i, type] of ['tank_mbt', 'artillery', 'heli_attack', 'aa_tank'].entries()) {
      w.spawnUnit(type, p.id, { x: hq.pos.x * 0.8 + i * 8, z: hq.pos.z * 0.8 }, 0);
    }
  }
  for (let t = 0; t < 2400; t++) {
    const commands: AnyPlayerCommand[] = [];
    for (const p of setup.players) {
      const mine = [...w.entities.values()].filter((e) => e.owner === p.id);
      const hq = mine.find((e) => e.type === 'hq');
      if (!hq) continue;
      if (t === 0) {
        const eng = mine.find((e) => e.type === 'engineer')!;
        const at = { x: hq.pos.x * 0.75, z: hq.pos.z };
        commands.push({ player: p.id, cmd: { type: 'build', builder: eng.id, structure: 'barracks', at, rotation: 0 } });
      }
      const rax = mine.find((e) => e.type === 'barracks' && e.buildProgress >= 1);
      if (rax && t % 100 === 0) {
        commands.push({ player: p.id, cmd: { type: 'setRally', factory: rax.id, at: { x: script.range(-40, 40), z: script.range(-40, 40) } } });
        commands.push({ player: p.id, cmd: { type: 'produce', factory: rax.id, unit: script.next() < 0.5 ? 'rifleman' : 'at_soldier', count: 2 } });
      }
      if (t % 150 === 75) {
        const ids = (type: string) => mine.filter((e) => e.type === type).map((e) => e.id);
        const at = { x: script.range(-40, 40), z: script.range(-40, 40) };
        commands.push({ player: p.id, cmd: { type: 'useAbility', units: ids('rifleman'), ability: 'smoke', at } });
        commands.push({ player: p.id, cmd: { type: 'useAbility', units: ids('artillery'), ability: 'barrage', at } });
        commands.push({ player: p.id, cmd: { type: 'useAbility', units: ids('at_soldier'), ability: script.next() < 0.5 ? 'entrench' : 'ambush' } });
        commands.push({ player: p.id, cmd: { type: 'useAbility', units: ids('rifleman'), ability: 'sprint' } });
      }
      if (t % 120 === 60) {
        const army = mine.filter((e) => e.kind === 'unit' && e.type !== 'engineer').map((e) => e.id);
        commands.push({ player: p.id, cmd: { type: 'move', units: army, target: { x: script.range(-30, 30), z: script.range(-30, 30) }, attackMove: true } });
      }
    }
    for (const ev of sim.step(commands)) if (ev.type in counts) counts[ev.type]++;
    for (const ev of sim.proposedEvents) if (ev.type in counts) counts[ev.type]++;
    if (t % 50 === 0) hashes.push(sim.hash());
  }
  hashes.push(sim.hash());
  return { hashes, counts };
}

describe('sim purity', () => {
  // Transcendentals and wall-clock/random sources differ between browsers or peers.
  const banned = [
    /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|cbrt|hypot|random)\b/,
    /\bDate\b/,
    /performance\.now/,
    /\*\*/,
    /from ['"]three/,
    /\bdocument\b|\bwindow\b/,
  ];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  for (const file of [...files('src/sim'), ...files('src/shared')]) {
    it(`${file} uses only deterministic APIs`, () => {
      const src = readFileSync(file, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      for (const re of banned) expect(src, `${re} found`).not.toMatch(re);
    });
  }
});
