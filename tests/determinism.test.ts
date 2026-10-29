import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlayerCommand } from '../src/shared/commands';
import type { MatchSetup } from '../src/shared/types';
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
    const commands: PlayerCommand[] = [];
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
  });
});

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
