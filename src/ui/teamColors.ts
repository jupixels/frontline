import type { MatchSetup, PlayerId } from '../shared/types';
import { TEAM_COLORS } from './lobbyApi';

// Display-only team colors (accessibility). Colors never affect the simulation, so each player may
// view a match in their own palette; lobby slots keep their canonical colors.

export type TeamPalette = 'standard' | 'colorblind' | 'contrast' | 'relative';

export const PALETTES: Record<Exclude<TeamPalette, 'relative'>, readonly string[]> = {
  standard: TEAM_COLORS,
  // Okabe–Ito, ordered so neighbors stay apart for protan/deutan/tritan viewers (ΔE ≥ 8.5).
  colorblind: ['#0072B2', '#D55E00', '#F0E442', '#009E73', '#56B4E9', '#CC79A7', '#E69F00', '#BBBBBB'],
  contrast: ['#3D7BE0', '#E8422F', '#F2DA1C', '#18B85A', '#B84DE0', '#F08A1A', '#25C7DB', '#E6E6E6'],
};

const SELF = '#3D7BE0';
const ALLIES = ['#25C7DB', '#18B85A', '#8FD35C'];
const ENEMIES = ['#E8422F', '#F08A1A', '#F2DA1C', '#B84DE0'];

export const PALETTE_INFO: { id: TeamPalette; label: string; detail: string; preview: readonly string[] }[] = [
  { id: 'standard', label: 'Standard', detail: 'The colors picked in the lobby.', preview: PALETTES.standard.slice(0, 6) },
  { id: 'colorblind', label: 'Colorblind-safe', detail: 'Okabe–Ito: tells sides apart with any color vision.', preview: PALETTES.colorblind.slice(0, 6) },
  { id: 'contrast', label: 'High contrast', detail: 'Saturated, bright team colors.', preview: PALETTES.contrast.slice(0, 6) },
  { id: 'relative', label: 'Friend / foe', detail: 'You blue, allies cyan and green, enemies red and orange.', preview: [SELF, ...ALLIES.slice(0, 2), ...ENEMIES.slice(0, 3)] },
];

/** `setup` with player colors remapped for display. Same object back for the standard palette. */
export function displaySetup(setup: MatchSetup, local: PlayerId, palette: TeamPalette): MatchSetup {
  if (palette === 'standard') return setup;
  const myTeam = setup.players.find((p) => p.id === local)?.team;
  let ally = 0;
  let enemy = 0;
  const players = setup.players.map((p) => {
    let color: string;
    if (palette === 'relative') {
      const mine = setup.players.find((q) => q.id === local);
      if (p.id === local || p.id === mine?.army || (p.army !== undefined && p.army === (mine?.army ?? local))) color = SELF;
      else if (p.team === myTeam) color = ALLIES[ally++ % ALLIES.length];
      else color = ENEMIES[enemy++ % ENEMIES.length];
    } else {
      const i = TEAM_COLORS.indexOf(p.color);
      color = PALETTES[palette][i >= 0 ? i : p.id % 8];
    }
    return { ...p, color };
  });
  return { ...setup, players };
}
