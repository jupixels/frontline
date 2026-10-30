import type { UnitDef } from '../shared/data';

// Unit and structure icons drawn as NATO-style map symbols (APP-6 frames and modifiers). They
// need no image assets, read well at 20 px, and fit the military look.

export type Symbol =
  | 'infantry'
  | 'antitank'
  | 'sniper'
  | 'engineer'
  | 'recon'
  | 'armor'
  | 'mechanized'
  | 'artillery'
  | 'rocket'
  | 'antiair'
  | 'helicopter'
  | 'jet'
  | 'naval'
  | 'submarine'
  | 'hq'
  | 'barracks'
  | 'factory'
  | 'supply'
  | 'power'
  | 'radar'
  | 'helipad'
  | 'airfield'
  | 'navalyard'
  | 'defense'
  | 'point'
  | 'unknown';

const BY_TYPE: Record<string, Symbol> = {
  rifleman: 'infantry',
  antitank: 'antitank',
  at_team: 'antitank',
  sniper: 'sniper',
  engineer: 'engineer',
  engineer_truck: 'engineer',
  jeep: 'recon',
  recon: 'recon',
  ifv: 'mechanized',
  apc: 'mechanized',
  tank_mbt: 'armor',
  tank_light: 'armor',
  mobile_aa: 'antiair',
  rocket_artillery: 'rocket',
  howitzer: 'artillery',
  attack_heli: 'helicopter',
  utility_heli: 'helicopter',
  fighter: 'jet',
  bomber: 'jet',
  hq: 'hq',
  barracks: 'barracks',
  war_factory: 'factory',
  factory: 'factory',
  supply_depot: 'supply',
  power_plant: 'power',
  radar: 'radar',
  helipad: 'helipad',
  airfield: 'airfield',
  naval_yard: 'navalyard',
  watchtower: 'defense',
  trench: 'defense',
  ruin: 'defense',
  strategic_command: 'radar',
  at_soldier: 'antitank',
  scout_car: 'recon',
  aa_tank: 'antiair',
  rocket_truck: 'rocket',
  artillery: 'artillery',
  heli_attack: 'helicopter',
  heli_transport: 'helicopter',
  jet_fighter: 'jet',
  point: 'point',
};

/** Best-effort symbol for an entity type, from its id first and its def second. */
export function symbolFor(type: string, def?: Pick<UnitDef, 'name' | 'domain' | 'armor'>): Symbol {
  const direct = BY_TYPE[type];
  if (direct) return direct;
  const n = `${type} ${def?.name ?? ''}`.toLowerCase();
  if (/sub/.test(n)) return 'submarine';
  if (def?.domain === 'naval' || /boat|ship|destroyer|cruiser|battleship/.test(n)) return 'naval';
  if (/heli/.test(n)) return 'helicopter';
  if (def?.domain === 'air' || /jet|fighter|bomber/.test(n)) return 'jet';
  if (/anti.?air|\baa\b/.test(n)) return 'antiair';
  if (/rocket|missile/.test(n)) return 'rocket';
  if (/artillery|howitzer|mortar/.test(n)) return 'artillery';
  if (/anti.?tank|bazooka|\bat\b/.test(n)) return 'antitank';
  if (/sniper/.test(n)) return 'sniper';
  if (/engineer|builder|dozer/.test(n)) return 'engineer';
  if (/ifv|apc|mech/.test(n)) return 'mechanized';
  if (/tank/.test(n)) return 'armor';
  if (/jeep|recon|scout/.test(n)) return 'recon';
  if (def?.armor === 'infantry') return 'infantry';
  if (def?.armor === 'heavy') return 'armor';
  if (def?.armor === 'light') return 'recon';
  if (def?.armor === 'structure') return 'factory';
  return 'unknown';
}

const STRUCTURES = new Set<Symbol>(['hq', 'barracks', 'factory', 'supply', 'power', 'radar', 'helipad', 'airfield', 'navalyard', 'defense']);

/** Inner marks drawn in a 48×32 frame (frame inset at x 4..44, y 4..28). */
function marks(sym: Symbol): string {
  const X = '<path d="M4 4 L44 28 M44 4 L4 28"/>';
  const ellipse = '<ellipse cx="24" cy="16" rx="13" ry="6.5"/>';
  switch (sym) {
    case 'infantry':
      return X;
    case 'antitank':
      return '<path d="M4 28 L24 5 L44 28"/>';
    case 'sniper':
      return `${X}<circle cx="24" cy="16" r="3" class="fill"/>`;
    case 'engineer':
      return '<path d="M14 21 V12 H34 V21 M24 12 V21"/>';
    case 'recon':
      return '<path d="M4 28 L44 4"/>';
    case 'armor':
      return ellipse;
    case 'mechanized':
      return `${X}${ellipse}`;
    case 'artillery':
      return '<circle cx="24" cy="16" r="4.5" class="fill"/>';
    case 'rocket':
      return '<circle cx="24" cy="19" r="3.5" class="fill"/><path d="M24 15 V7 M20 10 L24 6 L28 10"/>';
    case 'antiair':
      return '<path d="M8 28 Q24 4 40 28"/>';
    case 'helicopter':
      return '<path d="M12 9 L36 23 V9 L12 23 Z"/>';
    case 'jet':
      return '<path d="M24 16 C18 8 10 8 10 16 C10 24 18 24 24 16 C30 8 38 8 38 16 C38 24 30 24 24 16 Z"/>';
    case 'naval':
      return '<path d="M12 18 H36 L32 24 H16 Z M24 18 V9 M20 12 H28"/>';
    case 'submarine':
      return '<path d="M10 18 Q24 10 38 18 Q24 26 10 18 Z M24 14 V9"/>';
    case 'hq':
      return '<path d="M14 26 V7 M14 8 H32 L28 12.5 L32 17 H14"/>';
    case 'barracks':
      return '<path d="M10 8 L38 24 M38 8 L10 24"/>';
    case 'factory':
      return '<circle cx="24" cy="16" r="6"/><path d="M24 6 V9 M24 23 V26 M14 16 H17 M31 16 H34 M17 9 L19 11 M29 21 L31 23 M31 9 L29 11 M19 21 L17 23"/>';
    case 'supply':
      return '<path d="M4 22 H44"/>';
    case 'power':
      return '<path d="M27 6 L18 17 H25 L21 26 L31 14 H24 Z" class="fill"/>';
    case 'radar':
      return '<path d="M14 24 A12 12 0 0 1 34 10 M18 22 A7 7 0 0 1 29 13"/><circle cx="16" cy="24" r="2" class="fill"/>';
    case 'helipad':
      return '<path d="M17 9 V23 M31 9 V23 M17 16 H31"/>';
    case 'airfield':
      return '<path d="M8 16 H40 M24 8 L28 16 L24 24 M14 12 L18 16 L14 20"/>';
    case 'navalyard':
      return '<path d="M24 7 V25 M16 19 Q24 28 32 19 M19 11 H29"/>';
    case 'defense':
      return '<path d="M24 7 L36 13 V18 Q36 25 24 27 Q12 25 12 18 V13 Z"/>';
    case 'point':
      return '<path d="M24 6 L34 16 L24 26 L14 16 Z" class="fill"/>';
    default:
      return '<text x="24" y="21" text-anchor="middle" font-size="13" class="fill" stroke="none">?</text>';
  }
}

/**
 * Inline SVG for a symbol. Units get the rectangular friendly-ground frame, structures a
 * frame with a base line, points no frame. Colors come from CSS (`currentColor`).
 */
export function glyphSvg(sym: Symbol, cls = 'glyph'): string {
  const frame =
    sym === 'point'
      ? ''
      : STRUCTURES.has(sym)
        ? '<rect x="4" y="4" width="40" height="24" class="frame"/><path d="M2 30 H46" class="base"/>'
        : sym === 'helicopter' || sym === 'jet'
          ? '<path d="M4 28 V14 Q24 -6 44 14 V28 Z" class="frame"/>'
          : sym === 'naval' || sym === 'submarine'
            ? '<rect x="4" y="4" width="40" height="24" rx="12" class="frame"/>'
            : '<rect x="4" y="4" width="40" height="24" class="frame"/>';
  return `<svg class="${cls}" viewBox="0 0 48 32" aria-hidden="true">${frame}<g class="marks">${marks(sym)}</g></svg>`;
}

export function glyphFor(type: string, def?: Pick<UnitDef, 'name' | 'domain' | 'armor'>, cls?: string): string {
  return glyphSvg(symbolFor(type, def), cls);
}

/** Small inline SVG icons for command buttons. */
export const ICONS = {
  attack: '<svg viewBox="0 0 24 24"><path d="M4 20 L14 10 M10 6 L18 6 L18 14 M14 10 L18 6"/><path d="M4 16 L8 20"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>',
  hold: '<svg viewBox="0 0 24 24"><path d="M12 3 L19 6 V12 Q19 18 12 21 Q5 18 5 12 V6 Z"/></svg>',
  patrol: '<svg viewBox="0 0 24 24"><path d="M5 9 A7 7 0 0 1 18 7 M19 15 A7 7 0 0 1 6 17"/><path d="M15 4 L18 7 L15 10 M9 20 L6 17 L9 14"/></svg>',
  build: '<svg viewBox="0 0 24 24"><path d="M4 20 H20 M6 20 V11 L12 6 L18 11 V20 M10 20 V15 H14 V20"/></svg>',
  rally: '<svg viewBox="0 0 24 24"><path d="M7 21 V4 M7 5 H18 L15 8.5 L18 12 H7"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M14 6 L8 12 L14 18"/></svg>',
  cancel: '<svg viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M5 7 H19 M5 12 H19 M5 17 H19"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11"/><path d="M5 15 V5 H15"/></svg>',
  supply: '<svg viewBox="0 0 24 24"><path d="M4 9 L12 5 L20 9 L12 13 Z M4 9 V16 L12 20 L20 16 V9 M12 13 V20"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M13 3 L6 13 H11 L10 21 L18 10 H13 Z"/></svg>',
  cp: '<svg viewBox="0 0 24 24"><path d="M12 3 L14.5 9 H21 L15.8 13 L17.8 20 L12 15.8 L6.2 20 L8.2 13 L3 9 H9.5 Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7 V12 L15 14"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 4 L21 20 H3 Z M12 10 V14 M12 17 V17.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M6 21 V4 M6 5 H18 L15 8.5 L18 12 H6"/></svg>',
  enter: '<svg viewBox="0 0 24 24"><path d="M10 5 H19 V19 H10 M4 12 H14 M11 9 L14 12 L11 15"/></svg>',
  unload: '<svg viewBox="0 0 24 24"><path d="M14 5 H5 V19 H14 M10 12 H20 M17 9 L20 12 L17 15"/></svg>',
  line: '<svg viewBox="0 0 24 24"><path d="M3 15 Q8 9 12 13 T21 9"/><circle cx="6" cy="18" r="1.2"/><circle cx="12" cy="17" r="1.2"/><circle cx="18" cy="14" r="1.2"/></svg>',
  advance: '<svg viewBox="0 0 24 24"><path d="M4 18 Q12 13 20 18 M12 15 V4 M8 8 L12 4 L16 8"/></svg>',
  disband: '<svg viewBox="0 0 24 24"><path d="M3 14 Q8 9 12 13 T21 9"/><path d="M8 4 L16 20"/></svg>',
  missile: '<svg viewBox="0 0 24 24"><path d="M5 19 L15 9 M15 9 L19 5 L17 11 M15 9 L13 7 L19 5 M5 19 L4 16 M5 19 L8 20"/></svg>',
  smoke: '<svg viewBox="0 0 24 24"><path d="M6 17 A4 4 0 0 1 7 9 A5 5 0 0 1 16 8 A4 4 0 0 1 18 16 Z"/></svg>',
  entrench: '<svg viewBox="0 0 24 24"><path d="M3 17 H21 M5 17 L7 12 H17 L19 17 M9 12 V9 H15 V12"/></svg>',
  sprint: '<svg viewBox="0 0 24 24"><path d="M5 12 H13 M3 8 H10 M6 16 H12 M13 6 L19 12 L13 18"/></svg>',
  barrage: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="6"/><circle cx="12" cy="13" r="2"/><path d="M12 3 V6 M12 20 V23 M2 13 H5 M19 13 H22"/></svg>',
  ambush: '<svg viewBox="0 0 24 24"><path d="M3 12 Q12 4 21 12 Q12 20 3 12 Z M4 20 L20 4"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5 V19 M16 5 V19"/></svg>',
} as const;

/** Command-card icon for an ability id. */
export function abilityIcon(id: string): string {
  const m: Record<string, string> = { smoke: ICONS.smoke, entrench: ICONS.entrench, sprint: ICONS.sprint, overdrive: ICONS.sprint, barrage: ICONS.barrage, ambush: ICONS.ambush };
  return m[id] ?? ICONS.flag;
}
