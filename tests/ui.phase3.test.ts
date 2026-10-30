import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchSetup } from '../src/shared/types';
import { ENTITY_ICON_IDS, entityIcon, icon, ICON_IDS } from '../src/ui/icons';
import { ACTIONS, conflicts, defaultKeybinds, GROUP_ACTIONS, isBindable, SLOT_ACTIONS } from '../src/ui/keybinds';
import { TEAM_COLORS } from '../src/ui/lobbyApi';
import { ACHIEVEMENTS, emptyRecord, recordMatch, type MatchFacts } from '../src/ui/records';
import { displaySetup, PALETTES } from '../src/ui/teamColors';
import { productionTip, requirementText, strongVs, threatsTo, UNIT_DATA } from '../src/ui/unitInfo';

const facts = (f: Partial<MatchFacts> = {}): MatchFacts => ({
  won: true,
  durationSec: 1500,
  mode: 'skirmish',
  coop: false,
  kills: 10,
  structuresLost: 1,
  minMoraleFrac: 0.6,
  domains: new Set(['ground']),
  linesFormed: 0,
  missiles: 0,
  maxRank: 0,
  heldAllPoints: false,
  ...f,
});

const match = { at: '2026-10-30T00:00:00Z', mapId: 'm', mapName: 'Map', mode: 'skirmish', won: true, durationSec: 1500, kills: 10, lost: 3, produced: 20, built: 4, captures: 2, damage: 900, players: 2 };

describe('keybinds (accessibility: everything rebindable)', () => {
  it('default binds never put two live actions on one key', () => {
    const k = defaultKeybinds();
    for (const a of ACTIONS) for (const b of ACTIONS) if (a.id !== b.id && k[a.id] === k[b.id]) expect(conflicts(a.id, b.id), `${a.id} vs ${b.id}`).toBe(false);
  });

  it('every action has a bindable default, groups and 12 card slots included', () => {
    for (const a of ACTIONS) expect(isBindable(a.key), a.id).toBe(true);
    expect(GROUP_ACTIONS).toHaveLength(9);
    expect(SLOT_ACTIONS).toHaveLength(12);
  });

  it('the HUD reads hotkeys from the binds, not hard-coded keys', () => {
    // Any KeyboardEvent.code literal in HUD code (besides Escape and the menu fallback) would be a fixed key.
    const dir = 'src/ui/hud';
    for (const f of readdirSync(dir)) {
      const src = readFileSync(`${dir}/${f}`, 'utf8');
      const literals = [...src.matchAll(/code === '(\w+)'/g)].map((m) => m[1]).filter((c) => c !== 'Escape');
      expect(literals, f).toEqual([]);
    }
  });
});

describe('icons', () => {
  it('every unit and structure in data has a drawing, and glyphs are SVG', () => {
    const structures = JSON.parse(readFileSync('data/structures.json', 'utf8')) as Record<string, unknown>;
    for (const id of [...Object.keys(UNIT_DATA), ...Object.keys(structures)]) expect(ENTITY_ICON_IDS, id).toContain(id);
    for (const id of ICON_IDS) expect(icon(id)).toMatch(/^<svg class="ic ic-glyph"/);
    expect(entityIcon('tank_mbt', undefined, 'ic-lg')).toContain('ic-lg');
  });
});

describe('unit info (tooltips)', () => {
  it('derives counters from the damage table', () => {
    expect(strongVs('aa_tank')).toEqual(['air']);
    expect(strongVs('at_soldier')).toContain('heavy');
    expect(threatsTo('heli_attack')).toContain('aa_tank');
    expect(threatsTo('submarine')).toContain('destroyer');
  });

  it('explains locks and shortfalls', () => {
    expect(requirementText('tank_mbt', 1, () => true)).toMatch(/Tier 2.*Radar/);
    expect(requirementText('war_factory', 1, () => false)).toMatch(/Barracks/);
    expect(requirementText('rifleman', 1, () => true)).toBeNull();
    const tip = productionTip('tank_mbt', { supply: 100, hotkey: 'E' });
    expect(tip.warn).toMatch(/550 more supply/);
    expect(tip.costs?.[0]).toMatchObject({ kind: 'supply', poor: true });
    expect(tip.keys?.[0]).toEqual(['E', 'Train']);
  });
});

describe('records and medals', () => {
  it('tallies the career and awards each medal once', () => {
    const a = recordMatch(emptyRecord(), match, facts());
    expect(a.record.matches).toBe(1);
    expect(a.record.wins).toBe(1);
    expect(a.newMedals.map((m) => m.id)).toEqual(['first_win']);
    const b = recordMatch(a.record, match, facts({ minMoraleFrac: 0.1, vsAi: 'hard' }));
    expect(b.newMedals.map((m) => m.id).sort()).toEqual(['comeback', 'hard_target']);
    expect(b.record.history).toHaveLength(2);
    expect(b.record.history[0].medals).toEqual(['hard_target', 'comeback'].filter((id) => b.newMedals.some((m) => m.id === id)));
  });

  it('the tutorial only earns its medal', () => {
    const r = recordMatch(emptyRecord(), match, facts({ tutorial: true }));
    expect(r.record.matches).toBe(0);
    expect(r.record.tutorialDone).toBe(true);
    expect(r.newMedals.map((m) => m.id)).toEqual(['graduate']);
  });

  it('has unique medal ids', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });
});

describe('team palettes', () => {
  const setup: MatchSetup = {
    seed: 1,
    mapId: 'm',
    victory: 'frontline',
    players: [
      { id: 0, team: 0, name: 'A', color: TEAM_COLORS[0], kind: 'human' },
      { id: 1, team: 1, name: 'B', color: TEAM_COLORS[1], kind: 'ai' },
      { id: 2, team: 0, name: 'C', color: TEAM_COLORS[2], kind: 'human', army: 0 },
    ],
  };

  it('maps lobby colors onto the chosen palette without touching the original', () => {
    const s = displaySetup(setup, 0, 'colorblind');
    expect(s.players.map((p) => p.color)).toEqual([PALETTES.colorblind[0], PALETTES.colorblind[1], PALETTES.colorblind[2]]);
    expect(setup.players[0].color).toBe(TEAM_COLORS[0]);
    expect(displaySetup(setup, 0, 'standard')).toBe(setup);
  });

  it('friend/foe colors the shared army as "me"', () => {
    const s = displaySetup(setup, 2, 'relative');
    expect(s.players[0].color).toBe(s.players[2].color);
    expect(s.players[1].color).not.toBe(s.players[0].color);
  });
});

describe('credits', () => {
  it('builds model credits from the shipped catalog', async () => {
    const { modelCredits } = await import('../src/ui/screens/credits');
    const rows = modelCredits([
      { id: 'a', license: 'owned (Meshy Pro output)', credits: ['Frontline (Meshy)'] },
      { id: 'b', license: 'CC0 + CC-BY-4.0', credits: ['Kenney', 'Zsky'] },
      { id: 'c', license: 'CC0', credits: ['Kenney'] },
    ]);
    expect(rows[0]).toEqual({ credit: 'Kenney', licenses: ['CC0'], count: 2 });
    expect(rows.find((r) => r.credit === 'Zsky')?.licenses).toEqual(['CC0 + CC-BY-4.0']);
    expect(rows.find((r) => r.credit === 'Frontline (Meshy)')?.licenses).toEqual(['owned (Meshy Pro output)']);
    // Every model in this build carries a license and a credit line.
    const cat = JSON.parse(readFileSync('public/assets/models/catalog.json', 'utf8')) as { models: { id: string; license?: string; credits?: string[] }[] };
    for (const m of cat.models) expect(m.license && m.credits?.length, m.id).toBeTruthy();
  });
});
