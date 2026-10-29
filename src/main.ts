import units from '../data/units.json';
import sandbox from '../data/maps/sandbox.json';
import { Match } from './game/match';
import { LocalSession } from './net/session';
import type { MapDef, UnitDef } from './shared/data';
import type { MatchSetup } from './shared/types';

// Phase 0 entry: straight into a sandbox skirmish. The UI workstream adds menu → lobby → match.
const setup: MatchSetup = {
  seed: 1,
  mapId: 'sandbox',
  victory: 'frontline',
  players: [
    { id: 0, team: 0, name: 'You', color: '#4f8fe6', kind: 'human' },
    { id: 1, team: 1, name: 'Enemy', color: '#d9503f', kind: 'ai', aiDifficulty: 'normal' },
  ],
};

const loading = document.createElement('div');
loading.className = 'loading';
loading.textContent = 'FRONTLINE';
document.body.appendChild(loading);

const match = new Match(
  setup,
  { units: units as Record<string, UnitDef>, map: sandbox as MapDef },
  new LocalSession(0),
  document.getElementById('game') as HTMLCanvasElement,
  document.getElementById('ui')!,
);
match.start();

setTimeout(() => {
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 700);
}, 400);

// Handy for debugging in the console.
Object.assign(window, { match });
