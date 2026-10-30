import type { UnitDef } from '../shared/data';

// Frontline icon set. One style throughout: solid silhouettes in `currentColor` on a square grid,
// with knock-out details (`.k`, drawn in the panel color) and a few 2.2 px strokes (`.s`) where a
// solid shape would clog at 16 px. Units are side profiles facing right on a 32 grid (aircraft
// top-down); structures stand on a shared foundation line; orders, abilities and resources use a
// 24 grid. Colors come from CSS, so every icon follows the theme and team colors.

const K = (d: string) => `<path class="k" d="${d}"/>`;
const F = (d: string) => `<path d="${d}"/>`;
const S = (d: string) => `<path class="s" d="${d}"/>`;
const C = (cx: number, cy: number, r: number, cls = '') => `<circle${cls ? ` class="${cls}"` : ''} cx="${cx}" cy="${cy}" r="${r}"/>`;

// --- building blocks -----------------------------------------------------------------------------

/** Standing soldier with a rifle, feet around x 8..17. */
const SOLDIER =
  F('M9.4 6.4 Q12 3 14.8 6.4 L15.1 7.2 H9.1 Z') +
  C(12.1, 8, 1.9) +
  F('M8.4 10.4 H10.4 V15.4 H8.6 Z') +
  F('M10 9.8 H14.2 L15 17.2 H10.4 Z') +
  F('M10.4 16.8 H12.9 L10.3 26.8 H7.9 Z') +
  F('M12.4 16.8 H15 L17.2 26.8 H14.7 Z') +
  F('M11.2 11.2 H26 V12.7 H11.2 Z') +
  F('M10.3 11 H12.6 V14.6 H10.3 Z') +
  F('M13 10 L17.9 12.1 L17.3 13.6 L12.4 11.6 Z');

/** Tracks with knocked-out road wheels, x 3..29. */
function tracks(x0 = 3, x1 = 29, y = 21): string {
  const w = x1 - x0;
  let wheels = '';
  const n = Math.max(4, Math.round(w / 4.6));
  for (let i = 0; i < n; i++) wheels += C(+(x0 + 3 + ((w - 6) * i) / (n - 1)).toFixed(2), y + 3, 1.55, 'k');
  return `<rect x="${x0}" y="${y}" width="${w}" height="6" rx="3"/>${wheels}`;
}

function wheel(cx: number, cy: number, r: number): string {
  return C(cx, cy, r) + C(cx, cy, r * 0.38, 'k');
}

/** Water band under ships. */
const WATER = F('M0 27.4 Q2.7 26 5.3 27.4 T10.7 27.4 T16 27.4 T21.3 27.4 T26.7 27.4 T32 27.4 V29.6 H0 Z');
/** Foundation line under structures. */
const SLAB = F('M1 28 H31 V30 H1 Z');

// --- units (32 grid) -----------------------------------------------------------------------------

const UNIT: Record<string, string> = {
  rifleman: `<g class="o" transform="translate(-5.5 0)">${SOLDIER}</g><g transform="translate(3 0)">${SOLDIER}</g>`,
  at_soldier:
    F('M9.6 9.2 Q12 6 14.6 9.2 L14.9 10 H9.3 Z') +
    C(12, 10.8, 1.9) +
    F('M9.8 12.8 H14.2 L14.8 20 H10.2 Z') +
    F('M10 19.2 H16.6 L17 21.4 H10 Z') +
    F('M14.6 20 H17 V27 H14.6 Z') +
    F('M9.8 19.6 L12.4 21.2 L8.2 27 H5.6 Z') +
    F('M3.5 10.4 H24 V12.8 H3.5 Z') +
    F('M23.4 9.4 L28.6 10.7 V12.5 L23.4 13.8 Z') +
    F('M2.4 9.8 H4.6 V13.4 H2.4 Z') +
    F('M12.6 12.4 L16.6 15.6 L15.6 16.8 L11.8 13.8 Z'),
  sniper:
    F('M2 24.6 L7.4 23.4 L7.4 25.8 L2 26.4 Z') +
    F('M6 22.6 L19 21.4 L19.4 24.6 L6 25.6 Z') +
    F('M18.6 19.6 Q21 17.2 23.4 19.6 L23.6 20.4 H18.4 Z') +
    C(21, 21.2, 1.9) +
    F('M17.4 21.2 H30.6 V22.3 H17.4 Z') +
    F('M20.4 19.4 H25 V20.6 H20.4 Z') +
    F('M27 22 L28.8 26.4 L27.8 26.7 L26 22.3 Z') +
    F('M14 21.4 L18.6 22.2 L18.4 23.4 L14 22.8 Z'),
  engineer:
    F('M9.4 6.4 Q12 3 14.8 6.4 L15.1 7.2 H9.1 Z') +
    C(12.1, 8, 1.9) +
    F('M10 9.8 H14.2 L15 17.2 H10.4 Z') +
    F('M10.4 16.8 H12.9 L10.3 26.8 H7.9 Z') +
    F('M12.4 16.8 H15 L17.2 26.8 H14.7 Z') +
    F('M20.6 4.6 L21.8 5.8 L10.4 15.6 L9.2 14.4 Z') +
    F('M9.8 13.4 L5.6 17.8 L4 16.2 L7.6 11.6 Z') +
    F('M14 10.6 L17.4 15.6 L16.2 16.4 L12.8 11.6 Z') +
    F('M15.4 16.6 H21.6 V20.6 H15.4 Z') +
    K('M17.4 16.6 H19.6 V17.4 H17.4 Z'),
  jeep:
    F('M2.6 23.4 L3.6 17.6 L12 17 L14.4 12.6 H16 L15 17 L29 17.4 L30.2 21 L29.4 23.4 Z') +
    F('M19.8 11.6 H21.2 V17 H19.8 Z') +
    F('M16.6 10.6 H27.4 V12 H16.6 Z') +
    wheel(8, 24, 3.4) +
    wheel(24, 24, 3.4),
  scout_car:
    F('M2.4 22.6 L3.8 15.8 L9 13.6 H24.6 L29.6 16.6 L30.2 22.6 Z') +
    F('M11.6 13.8 L13.2 10 H20.2 L21.8 13.8 Z') +
    F('M20 10.8 H29.6 V12.1 H20 Z') +
    K('M24.8 15.2 L28 16.8 H24.8 Z') +
    wheel(8, 24, 3.4) +
    wheel(23.4, 24, 3.4),
  ifv:
    F('M3 21.2 L4.4 15 L8 12.6 H27 L30.2 15.4 L29.6 21.2 Z') +
    F('M14 12.8 L15.2 9.8 H21 L22.2 12.8 Z') +
    F('M21 10.6 H30.8 V11.7 H21 Z') +
    F('M13.6 8.4 H18 V9.8 H13.6 Z') +
    K('M4.8 15.6 H6.8 V20 H4.8 Z') +
    tracks(3, 29.4),
  tank_light:
    F('M2.6 21.2 L4.4 16.8 H27.2 L30.2 19 L29.6 21.2 Z') +
    F('M10 17 L12 13 H21 L23.6 15 V17 Z') +
    F('M23 14.4 H30.8 V15.8 H23 Z') +
    tracks(3, 29.2),
  tank_mbt:
    F('M1.8 21.2 L3.4 16.6 H27.6 L31 19 L30.6 21.2 Z') +
    F('M7.2 16.8 L8.8 12.4 L12 11.4 H21.2 L25.4 13.4 V16.8 Z') +
    F('M24.4 12.8 H32 V14.5 H24.4 Z') +
    F('M27.2 12.3 H28.8 V15 H27.2 Z') +
    F('M12.8 11.6 L13.4 9.8 H16.4 L17 11.6 Z') +
    tracks(2.4, 30),
  aa_tank:
    F('M2.6 21.2 L4.4 16.8 H27.2 L30.2 19 L29.6 21.2 Z') +
    F('M10.6 17 V12.4 H21.4 V17 Z') +
    F('M18.4 13 L26.2 5.2 L27.4 6.4 L19.6 14.2 Z') +
    F('M19.6 15 L27.6 7.6 L28.6 8.8 L20.6 16 Z') +
    F('M12.4 8.6 H13.6 V12.4 H12.4 Z') +
    F('M8.6 5.6 Q13 9.6 17.2 5.6 L16.6 7.6 Q13 10.6 9.4 7.6 Z') +
    tracks(3, 29.2),
  rocket_truck:
    F('M2 23.2 V19.6 H22.4 V23.2 Z') +
    F('M22.4 23.2 V15.4 L24.6 13 H28.8 L30.6 17 V23.2 Z') +
    K('M25 14.2 H28.2 L29.3 16.6 H25 Z') +
    F('M2.4 19.2 L3.2 14.6 L19.2 9.2 L20.6 13.6 L4.8 19.2 Z') +
    K('M17.4 10.6 L18.4 13.4 L17.2 13.8 L16.2 11 Z') +
    K('M14.6 11.6 L15.6 14.4 L14.4 14.8 L13.4 12 Z') +
    wheel(7, 24.4, 2.9) +
    wheel(19.6, 24.4, 2.9) +
    wheel(26, 24.4, 2.9),
  artillery:
    F('M2 21.2 L3.4 17 H28 L30.6 19 L30 21.2 Z') +
    F('M4.4 17.2 V11 L7 9.4 H17.6 L19.2 11.6 V17.2 Z') +
    F('M17 11.4 L30.4 4.4 L31.2 5.8 L17.8 12.8 Z') +
    F('M29.2 4.2 L30.8 3.4 L31.9 5.6 L30.3 6.4 Z') +
    tracks(2.4, 29.6),
  heli_attack:
    F('M5 17.6 L10 15.4 L18 14.4 L22 12.4 L26.6 12.8 L29.6 16 L28 19 L18 19.8 L10 18.8 Z') +
    F('M1.6 15.4 L10 16.2 V18 L1.6 17.2 Z') +
    F('M1 11.4 H3.4 L4 17.2 H1.8 Z') +
    F('M16.4 10.8 H18 V14.6 H16.4 Z') +
    F('M4.4 9.8 H30.4 V11 H4.4 Z') +
    F('M13.4 20.4 H23.4 V22.6 H13.4 Z') +
    F('M26.8 18.4 L30.4 19.6 L30.1 20.6 L26.6 19.5 Z') +
    K('M22.8 13.4 L26 13.6 L28.2 16 L23.2 15.8 Z'),
  heli_transport:
    F('M3 20.2 L4 13 H26 L29.6 15 L30.2 19 L27 21.2 H6 Z') +
    F('M3.4 13.2 L5 8.4 H9.4 V13.2 Z') +
    F('M23 9.6 H24.6 V13.2 H23 Z') +
    F('M0 7.6 H14.4 V8.8 H0 Z') +
    F('M16.6 8.8 H32 V10 H16.6 Z') +
    K('M25.6 14.2 H28.4 L29.2 16.4 H25.6 Z') +
    K('M10 15 H12.2 V17 H10 Z') +
    K('M14.4 15 H16.6 V17 H14.4 Z') +
    K('M18.8 15 H21 V17 H18.8 Z') +
    C(8.4, 22.8, 1.7) +
    C(24, 22.8, 1.7),
  jet_fighter:
    F('M1.6 15 L6 14 H22 L31 16 L22 18 H6 L1.6 17 Z') +
    F('M10 14.2 L16.8 3.4 H20 L18.6 14.2 Z') +
    F('M10 17.8 L16.8 28.6 H20 L18.6 17.8 Z') +
    F('M2 14.4 L3.6 8.8 H6.4 L7 14.2 Z') +
    F('M2 17.6 L3.6 23.2 H6.4 L7 17.8 Z') +
    K('M21 15.2 Q25 16 21 16.8 Z'),
  bomber:
    F('M29.6 16 L5 3 L3 5.6 L7.4 10 L3.8 12.6 L6.2 16 L3.8 19.4 L7.4 22 L3 26.4 L5 29 Z') +
    K('M23 15 Q26.4 16 23 17 Z'),
  patrol_boat:
    F('M1.6 19.6 H30.4 L27.2 25.2 H4.8 Z') +
    F('M8.6 19.8 V14.8 H17.2 L19.8 19.8 Z') +
    K('M14.4 15.8 H16.8 L18.2 18.2 H14.4 Z') +
    F('M12.6 9.6 H13.8 V14.8 H12.6 Z') +
    F('M21.6 17.4 H24.6 V19.8 H21.6 Z') +
    F('M23.6 17.8 H29 V18.9 H23.6 Z') +
    WATER,
  destroyer:
    F('M0.8 19.6 H31.2 L29 24.8 H3.8 Z') +
    F('M9.6 19.8 V14.4 H18 V19.8 Z') +
    F('M14.8 14.6 V11.8 H19.6 L20.6 14.6 Z') +
    F('M13.4 5.4 H14.6 V14.4 H13.4 Z') +
    F('M11.2 7.6 H16.8 V8.6 H11.2 Z') +
    F('M7 19.8 L7.6 15.2 H9.6 V19.8 Z') +
    F('M22 17.2 H25.2 V19.8 H22 Z') +
    F('M24.4 17.6 H29.6 V18.6 H24.4 Z') +
    WATER,
  cruiser:
    F('M0.4 18.8 H31.6 L29.6 24.8 H3 Z') +
    F('M9 19 V12.8 H20.4 V19 Z') +
    F('M11.8 13 V9.2 H18 V13 Z') +
    F('M14.4 2.6 H15.6 V9.2 H14.4 Z') +
    F('M12 4.6 H18 V5.6 H12 Z') +
    F('M21.8 16 H26 V19 H21.8 Z') +
    F('M25 16.6 H31.4 V17.6 H25 Z') +
    F('M3.6 16 H7.6 V19 H3.6 Z') +
    F('M0.4 16.6 H4.4 V17.6 H0.4 Z') +
    K('M10.8 14.4 H18.6 V15.6 H10.8 Z') +
    WATER,
  submarine:
    F('M1.8 22.2 Q2.6 18.6 8 18.6 H26 Q31.2 19 31.2 21.8 Q30.2 24.6 26 24.6 H6.4 Q1.8 24.6 1.8 22.2 Z') +
    F('M12 18.8 L13 13.4 H18.2 L19.4 18.8 Z') +
    F('M15 9.4 H15.9 V13.4 H15 Z') +
    F('M15 9.4 H17.6 V10.3 H15 Z') +
    F('M2.6 19.4 L0.8 16.4 H3 L5.2 19 Z') +
    `<path class="ks" d="M2 23.2 Q4.6 22 7.2 23.2 T12.4 23.2 T17.6 23.2 T22.8 23.2 T28 23.2 T33 23.2"/>` +
    WATER,
  transport_ship:
    F('M0.8 19 H31.2 L29.6 24.8 H3 Z') +
    F('M2.8 19.2 V11.4 H9 V19.2 Z') +
    K('M4 12.6 H7.8 V14.2 H4 Z') +
    F('M10.6 19.2 V15.4 H16.6 V19.2 Z') +
    F('M17.2 19.2 V15.4 H23.2 V19.2 Z') +
    F('M13.8 15 V11.6 H19.8 V15 Z') +
    F('M25 19.2 V8.6 H26.2 V19.2 Z') +
    F('M25.4 9 L30.4 12.4 L29.8 13.4 L25 10.2 Z') +
    WATER,
  supply_truck:
    F('M2 23.2 V15 Q2 12.4 4.6 12.4 H19.8 Q22.4 12.4 22.4 15 V23.2 Z') +
    F('M22.4 23.2 V15.4 L24.6 13 H28.8 L30.6 17 V23.2 Z') +
    K('M25 14.2 H28.2 L29.3 16.6 H25 Z') +
    K('M7.4 13 H8.4 V22.6 H7.4 Z') +
    K('M12.6 13 H13.6 V22.6 H12.6 Z') +
    K('M17.6 13 H18.6 V22.6 H17.6 Z') +
    wheel(7, 24.4, 2.9) +
    wheel(19.6, 24.4, 2.9) +
    wheel(26, 24.4, 2.9),
};

// --- structures (32 grid, standing on SLAB) -------------------------------------------------------

const STRUCTURE: Record<string, string> = {
  hq:
    F('M3 28 V17 H29 V28 Z') +
    F('M1.6 17.4 L16 11.2 L30.4 17.4 Z') +
    F('M13 12.6 V6.6 H19 V12.6 Z') +
    F('M15.6 0.8 H16.6 V6.8 H15.6 Z') +
    F('M16.6 1 H23 L21.4 2.8 L23 4.6 H16.6 Z') +
    K('M14 21.6 H18 V28 H14 Z') +
    K('M6 19.6 H9.4 V23 H6 Z') +
    K('M22.6 19.6 H26 V23 H22.6 Z') +
    SLAB,
  barracks:
    F('M2 28 V22 Q2 12.6 16 12.6 Q30 12.6 30 22 V28 Z') +
    K('M8.6 14.6 H9.6 V28 H8.6 Z') +
    K('M22.4 14.6 H23.4 V28 H22.4 Z') +
    K('M13.8 20.6 H18.2 V28 H13.8 Z') +
    SLAB,
  war_factory:
    F('M2 28 V14 L8 9.6 V14 L14 9.6 V14 L20 9.6 V14 L26 9.6 V14 H30 V28 Z') +
    F('M26.6 14 V3.4 H29.2 V14 Z') +
    K('M7 17.6 H21 V28 H7 Z') +
    F('M7 20.6 H21 V21.6 H7 Z') +
    F('M7 24 H21 V25 H7 Z') +
    K('M23.4 17.6 H27.4 V21 H23.4 Z') +
    SLAB,
  airfield:
    F('M1.6 28 V22 Q1.6 14.6 11 14.6 Q20.4 14.6 20.4 22 V28 Z') +
    K('M4.8 21.6 H17.2 V28 H4.8 Z') +
    F('M23 28 V11 H26.4 V28 Z') +
    F('M20.8 11.2 L22 6.6 H27.4 L28.6 11.2 Z') +
    K('M22.6 7.8 H26.8 V10 H22.6 Z') +
    F('M20.6 5.2 H29 V6.6 H20.6 Z') +
    SLAB,
  helipad:
    `<g transform="translate(1.5 -1.6) scale(0.9)">${UNIT.heli_attack}</g>` +
    F('M2.4 28 V24.2 H29.6 V28 Z') +
    K('M13.4 25 H14.4 V27.2 H13.4 Z M17.6 25 H18.6 V27.2 H17.6 Z M14.4 25.7 H17.6 V26.5 H14.4 Z') +
    SLAB,
  naval_yard:
    F('M2.6 9.8 H29.4 V12.4 H2.6 Z') +
    F('M4.6 28 V12.2 H7.4 V28 Z') +
    F('M11.6 28 V12.2 H14.4 V28 Z') +
    F('M7.4 15 H11.6 V16.2 H7.4 Z') +
    F('M23.8 12.2 H24.8 V18.4 H23.8 Z') +
    F('M22.6 18.2 H26 V20.4 H22.6 Z') +
    F('M2.6 8 L6 9.8 H3.4 Z') +
    F('M16.6 25 Q19.3 23.4 22 25 T27.3 25 T32 25 V28 H16.6 Z') +
    SLAB,
  power_plant:
    F('M4.6 28 Q8.4 19.6 6.4 9 H17.6 Q15.6 19.6 19.4 28 Z') +
    C(9, 6.2, 2.4) +
    C(12.6, 4.6, 3) +
    C(16.2, 6, 2.2) +
    F('M19.6 28 V17.4 H29.6 V28 Z') +
    K('M25.2 18.8 L22.4 23.4 H24.6 L23.4 27 L27.2 22 H24.8 L26.4 18.8 Z') +
    SLAB,
  supply_depot:
    F('M2.6 28 V15 Q2.6 12.6 9.4 12.6 Q16.2 12.6 16.2 15 V28 Z') +
    K('M2.6 19 H16.2 V20 H2.6 Z') +
    K('M2.6 23.6 H16.2 V24.6 H2.6 Z') +
    F('M17.2 28 V21.8 H23.6 V28 Z') +
    F('M24.2 28 V21.8 H30.6 V28 Z') +
    F('M20.6 21.2 V15 H27.2 V21.2 Z') +
    K('M19.8 24.4 H21 V25.6 H19.8 Z M26.8 24.4 H28 V25.6 H26.8 Z M23.3 17.6 H24.5 V18.8 H23.3 Z') +
    SLAB,
  radar:
    F('M13.2 28 L15.2 13.4 H16.8 L18.8 28 H16.9 L16 18.8 L15.1 28 Z') +
    F('M10 28 V24.4 H22 V28 Z') +
    F('M5.4 7.4 Q16 18.8 26.6 7.4 L24.6 6.2 Q16 14.6 7.4 6.2 Z') +
    F('M15.5 11.6 L16.5 11.6 L16.3 4.6 L15.7 4.6 Z') +
    F('M14.8 3 H17.2 V5 H14.8 Z') +
    SLAB,
  hospital:
    F('M1.6 28 L7.6 15 H24.4 L30.4 28 Z') +
    F('M7.6 15.2 L16 9.6 L24.4 15.2 Z') +
    K('M14.6 16.6 H17.4 V19.4 H20.2 V22.2 H17.4 V25 H14.6 V22.2 H11.8 V19.4 H14.6 Z') +
    SLAB,
  watchtower:
    F('M8 28 L11 13 H12.8 L10.4 28 Z') +
    F('M24 28 L21 13 H19.2 L21.6 28 Z') +
    F('M10.4 20.6 H21.6 V21.6 H10.4 Z') +
    F('M9 13.2 V7 H23 V13.2 Z') +
    K('M11 8.4 H21 V11 H11 Z') +
    F('M7.4 7.2 L16 2.4 L24.6 7.2 Z') +
    SLAB,
  trench:
    '<ellipse cx="6" cy="25.8" rx="3.4" ry="2"/><ellipse cx="12.6" cy="25.8" rx="3.4" ry="2"/><ellipse cx="19.2" cy="25.8" rx="3.4" ry="2"/><ellipse cx="25.8" cy="25.8" rx="3.4" ry="2"/>' +
    '<ellipse cx="9.3" cy="22" rx="3.4" ry="2"/><ellipse cx="15.9" cy="22" rx="3.4" ry="2"/><ellipse cx="22.5" cy="22" rx="3.4" ry="2"/>' +
    '<ellipse cx="12.6" cy="18.2" rx="3.4" ry="2"/><ellipse cx="19.2" cy="18.2" rx="3.4" ry="2"/>' +
    S('M3 13 L29 13') +
    S('M6 10.6 L8 15.4 M12 10.6 L14 15.4 M18 10.6 L20 15.4 M24 10.6 L26 15.4') +
    SLAB,
  ruin:
    F('M2.6 28 V12 L6.6 8.6 L8.6 12.8 L11 9.6 V16.2 L14 14 V28 Z') +
    K('M5 15 H8.6 V19.6 H5 Z') +
    F('M16 28 V18 L19.8 14.6 L22.8 19 L25 16.8 L29.4 21 V28 Z') +
    K('M19 21 H22 V24.4 H19 Z') +
    SLAB,
  strategic_command:
    F('M14 25 V8.4 Q16 2.4 18 8.4 V25 Z') +
    F('M14 20.6 L10.6 25 H14 Z') +
    F('M18 20.6 L21.4 25 H18 Z') +
    K('M14 12.6 H18 V13.6 H14 Z') +
    F('M5.4 28 V5.6 H8 V28 Z') +
    F('M8 9.6 H13.4 V10.8 H8 Z') +
    F('M8 17.6 H13.4 V18.8 H8 Z') +
    F('M3.4 28 V25 H28.6 V28 Z') +
    SLAB,
  point:
    F('M16 3 L29 16 L16 29 L3 16 Z') +
    K('M13.4 8.6 H14.8 V23.4 H13.4 Z') +
    K('M14.8 9 H21.4 L19.6 11.6 L21.4 14.2 H14.8 Z'),
};

/** Unit and structure ids that look alike in the model folder map onto these keys. */
const ALIAS: Record<string, string> = {
  antitank: 'at_soldier',
  at_team: 'at_soldier',
  engineer_truck: 'engineer',
  recon: 'jeep',
  apc: 'ifv',
  mobile_aa: 'aa_tank',
  rocket_artillery: 'rocket_truck',
  howitzer: 'artillery',
  attack_heli: 'heli_attack',
  utility_heli: 'heli_transport',
  fighter: 'jet_fighter',
  factory: 'war_factory',
};

/** Best-effort icon key for a type with no drawing of its own. */
function fallbackKey(type: string, def?: Pick<UnitDef, 'name' | 'domain' | 'armor'>): string {
  const n = `${type} ${def?.name ?? ''}`.toLowerCase();
  if (/sub/.test(n)) return 'submarine';
  if (def?.domain === 'naval' || /boat|ship|destroyer|cruiser|battleship/.test(n)) return /transport/.test(n) ? 'transport_ship' : 'destroyer';
  if (/heli/.test(n)) return /transport|utility/.test(n) ? 'heli_transport' : 'heli_attack';
  if (def?.domain === 'air' || /jet|fighter/.test(n)) return /bomb/.test(n) ? 'bomber' : 'jet_fighter';
  if (/anti.?air|\baa\b/.test(n)) return 'aa_tank';
  if (/rocket|missile/.test(n)) return 'rocket_truck';
  if (/artillery|howitzer|mortar/.test(n)) return 'artillery';
  if (/anti.?tank|bazooka|\bat\b/.test(n)) return 'at_soldier';
  if (/sniper/.test(n)) return 'sniper';
  if (/engineer|builder/.test(n)) return 'engineer';
  if (/truck|supply/.test(n)) return 'supply_truck';
  if (/ifv|apc|mech/.test(n)) return 'ifv';
  if (/tank/.test(n)) return 'tank_mbt';
  if (/jeep|recon|scout/.test(n)) return 'jeep';
  if (def?.armor === 'infantry') return 'rifleman';
  if (def?.armor === 'heavy') return 'tank_mbt';
  if (def?.armor === 'light') return 'scout_car';
  if (def?.armor === 'structure') return 'war_factory';
  return 'rifleman';
}

/** Whether a type id has a structure drawing (used for styling). */
export function isStructureIcon(type: string): boolean {
  return (ALIAS[type] ?? type) in STRUCTURE;
}

/**
 * Inline SVG for a unit, structure or capture point type. `cls` adds classes (size helpers such as
 * `ic-lg`). The icon is drawn in `currentColor`; set `color` on a parent for team color.
 */
export function entityIcon(type: string, def?: Pick<UnitDef, 'name' | 'domain' | 'armor'>, cls = ''): string {
  const key = ALIAS[type] ?? type;
  const body = UNIT[key] ?? STRUCTURE[key] ?? UNIT[fallbackKey(type, def)] ?? UNIT.rifleman;
  const kind = key in STRUCTURE ? 'ic-structure' : 'ic-unit';
  return `<svg class="ic ic-entity ${kind}${cls ? ` ${cls}` : ''}" viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
}

// --- orders, abilities, resources, interface (24 grid) --------------------------------------------

const GLYPH = {
  move: F('M12 1.8 C7.8 1.8 4.8 5 4.8 9 C4.8 14.4 12 22.2 12 22.2 C12 22.2 19.2 14.4 19.2 9 C19.2 5 16.2 1.8 12 1.8 Z') + C(12, 9, 2.7, 'k'),
  attackMove:
    F('M15 3 A6 6 0 1 1 15 15 A6 6 0 1 1 15 3 Z M15 5.2 A3.8 3.8 0 1 0 15 12.8 A3.8 3.8 0 1 0 15 5.2 Z') +
    C(15, 9, 1.4) +
    S('M3 21 L10.6 13.4') +
    F('M2.2 16.6 L7.2 21.6 L3.4 22.4 L1.6 20.6 Z'),
  attack: F('M12 2 A10 10 0 1 1 12 22 A10 10 0 1 1 12 2 Z M12 4.6 A7.4 7.4 0 1 0 12 19.4 A7.4 7.4 0 1 0 12 4.6 Z') + F('M11 0.6 H13 V7.6 H11 Z M11 16.4 H13 V23.4 H11 Z M0.6 11 H7.6 V13 H0.6 Z M16.4 11 H23.4 V13 H16.4 Z') + C(12, 12, 1.8),
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  hold: F('M12 2.2 L20.2 5.4 V11.4 C20.2 16.6 16.6 20.4 12 21.8 C7.4 20.4 3.8 16.6 3.8 11.4 V5.4 Z') + K('M8.4 11.2 H15.6 V13 H8.4 Z'),
  patrol: S('M5.2 10 A7.2 7.2 0 0 1 17.6 7.2') + F('M14.6 3.4 L20.2 5.2 L17.4 10.2 Z') + S('M18.8 14 A7.2 7.2 0 0 1 6.4 16.8') + F('M9.4 20.6 L3.8 18.8 L6.6 13.8 Z'),
  build: F('M13.4 3.2 L20.8 10.6 L18.6 12.8 L16.8 11 L6.8 21 C6 21.8 4.6 21.8 3.8 21 C3 20.2 3 18.8 3.8 18 L13.8 8 L11.2 5.4 Z'),
  rally: F('M5 2.4 H7 V21.6 H5 Z') + F('M7 3.4 H19.4 L16.2 7.6 L19.4 11.8 H7 Z'),
  enter: S('M13 4 H19.4 V20 H13') + F('M2.6 10.6 H9.8 V7.6 L14.6 12 L9.8 16.4 V13.4 H2.6 Z'),
  unload: S('M11 4 H4.6 V20 H11') + F('M8.6 10.6 H15.8 V7.6 L20.6 12 L15.8 16.4 V13.4 H8.6 Z'),
  line: S('M2.4 13.6 C6 8 9 8.4 12 12.4 S18 16.6 21.6 9.6') + F('M4.2 18.6 L6.2 15.4 L8.2 18.6 Z M11 19.6 L13 16.4 L15 19.6 Z M17.4 17.6 L19.4 14.4 L21.4 17.6 Z'),
  advance: S('M2.4 19.4 C6.6 15.8 9.6 16 12 18 S18 20.4 21.6 16.6') + F('M12 2.4 L17.6 8.6 H13.6 V14.6 H10.4 V8.6 H6.4 Z'),
  disband: S('M2.4 13.6 C6 8 9 8.4 12 12.4 S18 16.6 21.6 9.6') + S('M5 3.4 L19 20.6'),
  back: S('M15 4.6 L7.6 12 L15 19.4'),
  cancel: S('M6 6 L18 18 M18 6 L6 18'),
  rotate: S('M19.4 12.6 A7.4 7.4 0 1 1 16.4 6.4') + F('M13.8 2.4 L20.4 4.4 L17 10.2 Z'),
  missile:
    F('M5.4 15.4 L14.6 6.2 C16.6 4.2 19.8 3.4 20.8 3.2 C20.6 4.2 19.8 7.4 17.8 9.4 L8.6 18.6 Z') +
    F('M5.4 15.4 L2.6 15.2 L5.2 12 L8 12 Z') +
    F('M8.6 18.6 L8.8 21.4 L12 18.8 L12 16 Z') +
    F('M4.4 19.6 L2 22 M3 18 L1.6 19.4') +
    S('M4.6 19.4 L2.4 21.6'),
  smoke: F('M6.6 19.4 C3.4 19.4 2.2 16.6 3.4 14.6 C4 13.6 5 13 6 13 C5.8 9.8 8 7.6 10.8 7.8 C11.8 5.6 14.8 4.6 17 5.8 C18.8 6.8 19.6 8.8 19.2 10.6 C21.2 11 22.2 13 21.8 15 C21.4 17.6 19.6 19.4 17.2 19.4 Z'),
  entrench:
    F('M17 1.4 L22.6 7 L21 8.6 L15.4 3 Z') +
    F('M17.8 3.8 L19.8 5.8 L13 12.6 L11 10.6 Z') +
    F('M10.2 9.4 L14.6 13.8 L9.4 19 C8.2 20.2 5.6 20.6 3.6 20.2 C3.2 18.2 3.6 15.6 4.8 14.4 Z'),
  sprint: F('M3 5 H7.4 L14.2 12 L7.4 19 H3 L9.8 12 Z') + F('M10.4 5 H14.8 L21.6 12 L14.8 19 H10.4 L17.2 12 Z'),
  overdrive: S('M3.6 17.4 A8.8 8.8 0 1 1 20.4 17.4') + F('M10.6 15.6 L18.2 7.6 L13.4 17.4 Z') + C(12, 16.4, 2.2),
  barrage: F('M12 1.6 L13.9 8.2 L20.4 5.4 L16.6 10.9 L22.4 13.4 L15.9 14.4 L17.6 21 L12 16.8 L6.4 21 L8.1 14.4 L1.6 13.4 L7.4 10.9 L3.6 5.4 L10.1 8.2 Z') + C(12, 12.6, 2.4, 'k'),
  ambush: F('M1.8 12 C5.4 5.8 18.6 5.8 22.2 12 C18.6 18.2 5.4 18.2 1.8 12 Z') + C(12, 12, 3.2, 'k') + C(12, 12, 1.5) + S('M4 21 L20 3'),
  supply: F('M12 2.4 L21 6.8 V17.2 L12 21.6 L3 17.2 V6.8 Z') + `<path class="ks" d="M3.6 7.2 L12 11.4 L20.4 7.2 M12 11.4 V21"/>`,
  power: F('M13.6 1.8 L4.8 13.6 H10.8 L9.4 22.2 L19.2 9.6 H13.2 Z'),
  cp: F('M12 2.2 L14.7 8.5 L21.5 9.1 L16.3 13.6 L17.9 20.2 L12 16.6 L6.1 20.2 L7.7 13.6 L2.5 9.1 L9.3 8.5 Z'),
  morale: F('M4.6 2 H6.6 V22 H4.6 Z') + F('M6.6 3.4 C10.4 1.8 13.4 5.8 19.6 3.8 V13.4 C13.4 15.4 10.4 11.4 6.6 13 Z'),
  clock: S('M12 3.4 A8.6 8.6 0 1 1 11.99 3.4 Z') + S('M12 7.4 V12 L15.2 14.2'),
  tier: F('M12 2.6 L20.6 8.8 V12 L12 5.8 L3.4 12 V8.8 Z') + F('M12 9.6 L20.6 15.8 V19 L12 12.8 L3.4 19 V15.8 Z'),
  point: F('M12 1.6 L22.4 12 L12 22.4 L1.6 12 Z') + K('M10 6.8 H11.2 V17.2 H10 Z') + K('M11.2 7 H16 L14.6 9 L16 11 H11.2 Z'),
  army: F('M2.6 15.2 C2.6 8.2 6.8 4.4 12 4.4 C17.2 4.4 21.4 8.2 21.4 15.2 H23 V17.8 H1 V15.2 Z') + K('M6 15.2 C6 10.8 8.4 8 12 7.6 C9.6 9 8.6 11.8 8.6 15.2 Z'),
  idle: F('M6 2.4 H18 V5 H6 Z M6 19 H18 V21.6 H6 Z') + F('M7.4 5 H16.6 C16.6 9 12.8 10.4 12.8 12 C12.8 13.6 16.6 15 16.6 19 H7.4 C7.4 15 11.2 13.6 11.2 12 C11.2 10.4 7.4 9 7.4 5 Z') + K('M9.6 17.6 L12 15 L14.4 17.6 Z'),
  production: F('M2.4 21 V10 L8 6.4 V10 L13.6 6.4 V10 L19.2 6.4 V21 Z') + F('M19.8 21 V2.6 H22.2 V21 Z') + K('M6 13.2 H15.6 V21 H6 Z'),
  menu: S('M4.6 6.6 H19.4 M4.6 12 H19.4 M4.6 17.4 H19.4'),
  copy: '<rect class="s" x="8.4" y="8.4" width="11.6" height="11.6" rx="1.6"/>' + S('M4.6 15.4 V5.6 C4.6 5 5 4.6 5.6 4.6 H15.4'),
  alert: F('M12 2.4 L22.6 20.8 H1.4 Z') + K('M10.9 8.6 H13.1 V14.6 H10.9 Z') + C(12, 17.4, 1.3, 'k'),
  info: F('M12 1.8 A10.2 10.2 0 1 1 11.99 1.8 Z') + K('M10.8 10 H13.2 V17.4 H10.8 Z') + C(12, 7, 1.4, 'k'),
  check: S('M4.4 12.6 L9.6 17.6 L19.8 6.4'),
  lost: F('M12 2.2 L20.2 5.4 V11.4 C20.2 16.6 16.6 20.4 12 21.8 C7.4 20.4 3.8 16.6 3.8 11.4 V5.4 Z') + K('M12.4 4.6 L9.8 10.6 L13.2 11.6 L10.6 19 L11.2 19.2 L15 10.6 L11.8 9.8 L13.6 4.8 Z'),
  pause: F('M6 4 H10 V20 H6 Z M14 4 H18 V20 H14 Z'),
  play: F('M6.4 3.6 L19.6 12 L6.4 20.4 Z'),
  fastForward: F('M2.4 5 L11.6 12 L2.4 19 Z M12.4 5 L21.6 12 L12.4 19 Z'),
  stepBack: F('M4 4.4 H7 V19.6 H4 Z') + F('M20 4.6 V19.4 L8.6 12 Z'),
  eye: F('M1.8 12 C5.4 5.8 18.6 5.8 22.2 12 C18.6 18.2 5.4 18.2 1.8 12 Z') + C(12, 12, 3.4, 'k') + C(12, 12, 1.6),
  trophy: F('M6.6 2.6 H17.4 V9 C17.4 12.4 15 14.6 12 14.6 C9 14.6 6.6 12.4 6.6 9 Z') + S('M6.8 5 H3.4 C3.4 8.6 4.8 10 7.2 10.4 M17.2 5 H20.6 C20.6 8.6 19.2 10 16.8 10.4') + F('M10.8 14.4 H13.2 V18 H10.8 Z M7.4 18.2 H16.6 V21.4 H7.4 Z'),
  chart: F('M3 3 H5 V19 H21 V21 H3 Z') + S('M6.8 15.4 L10.6 10.6 L14 13.2 L19.6 6.6'),
  replay: '<rect x="2.4" y="5" width="19.2" height="14" rx="1.6"/>' + K('M9.6 8.6 L15.6 12 L9.6 15.4 Z') + K('M4 6.6 H6 V8 H4 Z M4 16 H6 V17.4 H4 Z M18 6.6 H20 V8 H18 Z M18 16 H20 V17.4 H18 Z'),
  tutorial: F('M12 3.6 L23 8.8 L12 14 L1 8.8 Z') + F('M5.4 11.6 V16.4 C7.4 18.6 9.6 19.4 12 19.4 C14.4 19.4 16.6 18.6 18.6 16.4 V11.6 L12 14.8 Z') + F('M20.4 10.4 H21.8 V17 H20.4 Z'),
  gear: F('M10.4 1.8 H13.6 L14.2 4.6 L16.6 5.6 L19 4 L21.2 6.2 L19.6 8.6 L20.6 11 L23.2 11.6 V14.8 L20.6 15.4 L19.6 17.8 L21.2 20.2 L19 22.4 L16.6 20.8 L14.2 21.8 L13.6 24.4 H10.4 L9.8 21.8 L7.4 20.8 L5 22.4 L2.8 20.2 L4.4 17.8 L3.4 15.4 L0.8 14.8 V11.6 L3.4 11 L4.4 8.6 L2.8 6.2 L5 4 L7.4 5.6 L9.8 4.6 Z', ) + C(12, 13.2, 3.6, 'k'),
  globe: S('M12 2.6 A9.4 9.4 0 1 1 11.99 2.6 Z M2.6 12 H21.4 M12 2.6 C8.4 6 8.4 18 12 21.4 C15.6 18 15.6 6 12 2.6 Z'),
  team: F('M1.6 15 C1.6 9.6 4.6 6.8 8.2 6.8 C11.8 6.8 14.8 9.6 14.8 15 H16 V17 H0.4 V15 Z') + F('M10.4 10.4 C11.8 8.2 13.8 7.2 15.8 7.2 C19.4 7.2 22.4 10 22.4 15.4 H23.6 V17.4 H16.2 V15 C16.2 13.2 15.4 11.6 14.2 10.4 Z'),
  credits: F('M4 2.6 H16 L20 6.6 V21.4 H4 Z') + K('M7 9 H17 V10.4 H7 Z M7 12.6 H17 V14 H7 Z M7 16.2 H13.4 V17.6 H7 Z'),
  link: S('M10 14 L14 10 M8.6 11.4 L6.4 13.6 C4.8 15.2 4.8 17.6 6.4 19.2 C8 20.8 10.4 20.8 12 19.2 L14.2 17 M15.4 12.6 L17.6 10.4 C19.2 8.8 19.2 6.4 17.6 4.8 C16 3.2 13.6 3.2 12 4.8 L9.8 7'),
  upload: S('M12 15.6 V3.6 M7 8.4 L12 3.4 L17 8.4 M3.6 15 V20.4 H20.4 V15'),
  download: S('M12 3.4 V15.4 M7 10.6 L12 15.6 L17 10.6 M3.6 15 V20.4 H20.4 V15'),
  lock: '<rect x="4.6" y="10.4" width="14.8" height="11" rx="1.6"/>' + S('M7.8 10.4 V7.4 C7.8 5 9.6 3.2 12 3.2 C14.4 3.2 16.2 5 16.2 7.4 V10.4'),
  medal: F('M7 1.8 H11 L12 6 L13 1.8 H17 L14.4 9.4 H9.6 Z') + F('M12 9 A6.6 6.6 0 1 1 11.99 9 Z') + K('M12 11.6 L13.3 14.2 L16.1 14.6 L14 16.6 L14.5 19.4 L12 18 L9.5 19.4 L10 16.6 L7.9 14.6 L10.7 14.2 Z'),
  skull: F('M12 2.4 C6.8 2.4 3.4 6 3.4 10.6 C3.4 13.6 4.8 15.6 6.8 16.6 V20.6 H17.2 V16.6 C19.2 15.6 20.6 13.6 20.6 10.6 C20.6 6 17.2 2.4 12 2.4 Z') + C(8.6, 11, 2.2, 'k') + C(15.4, 11, 2.2, 'k') + K('M11 14 H13 L12 16.4 Z M9.4 18 H10.6 V20.6 H9.4 Z M13.4 18 H14.6 V20.6 H13.4 Z'),
  touch: F('M9.4 3.4 C10.6 3.4 11.4 4.2 11.4 5.4 V11.2 L17.6 12.4 C19.2 12.8 20 14.2 19.6 15.8 L18.2 21.6 H9 L4.4 15.6 C3.8 14.8 4 13.6 4.8 13.2 C5.6 12.6 6.6 12.8 7.2 13.6 L7.4 13.8 V5.4 C7.4 4.2 8.2 3.4 9.4 3.4 Z'),
  plus: S('M12 4.6 V19.4 M4.6 12 H19.4'),
  minus: S('M4.6 12 H19.4'),
  keyboard: '<rect class="s" x="1.8" y="5.6" width="20.4" height="12.8" rx="2"/>' + F('M5 8.6 H7 V10.6 H5 Z M9 8.6 H11 V10.6 H9 Z M13 8.6 H15 V10.6 H13 Z M17 8.6 H19 V10.6 H17 Z M7 13.4 H17 V15.4 H7 Z'),
  sound: F('M3 9 H7.4 L13 4.4 V19.6 L7.4 15 H3 Z') + S('M16 8.6 C17.4 10.2 17.4 13.8 16 15.4 M18.8 5.8 C21.6 9 21.6 15 18.8 18.2'),
  display: '<rect class="s" x="2.2" y="3.8" width="19.6" height="13.2" rx="1.6"/>' + F('M8.4 18.4 H15.6 V20.6 H8.4 Z'),
  access: C(12, 4.4, 2.2) + F('M3.4 7.6 H20.6 V9.8 L14.4 10.8 V14.4 L16.4 21.6 H14 L12 15.6 L10 21.6 H7.6 L9.6 14.4 V10.8 L3.4 9.8 Z'),
  target: S('M12 3.6 A8.4 8.4 0 1 1 11.99 3.6 Z') + C(12, 12, 3) + S('M12 0.8 V5 M12 19 V23.2 M0.8 12 H5 M19 12 H23.2'),
} as const;

export type IconId = keyof typeof GLYPH;

/** Inline SVG for an interface icon. */
export function icon(id: IconId, cls = ''): string {
  return `<svg class="ic ic-glyph${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${GLYPH[id]}</svg>`;
}

/** Icon ids as an array (for the dev icon sheet and tests). */
export const ICON_IDS = Object.keys(GLYPH) as IconId[];
export const ENTITY_ICON_IDS = [...Object.keys(UNIT), ...Object.keys(STRUCTURE)];

/** Command-card icon for an ability id. */
export function abilityIcon(id: string, cls = ''): string {
  const m: Record<string, IconId> = { smoke: 'smoke', entrench: 'entrench', sprint: 'sprint', overdrive: 'overdrive', barrage: 'barrage', ambush: 'ambush' };
  return icon(m[id] ?? 'target', cls);
}
