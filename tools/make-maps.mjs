// Generates the launch maps in data/maps/ from compact, symmetric descriptions.
//   node tools/make-maps.mjs
// Two-player maps use 180-degree rotational symmetry, the four-corner map uses 90-degree symmetry,
// so every side gets exactly the same ground. Edit this file, not the JSON.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'maps');
const r1 = (v) => Math.round(v * 10) / 10;

// --- symmetry helpers -------------------------------------------------------------------------

/** Rotate [x, z] by k quarter turns (k=2: 180 degrees). */
function rotP([x, z], k) {
  for (let i = 0; i < k; i++) [x, z] = [-z, x];
  return [r1(x), r1(z)];
}
const rotXZ = (o, k) => {
  const [x, z] = rotP([o.x, o.z], k);
  return { ...o, x, z };
};
function rotShape(s, k) {
  if (s.shape === 'circle') return rotXZ(s, k);
  if (s.shape === 'rect') return { ...rotXZ(s, k), w: k % 2 ? s.d : s.w, d: k % 2 ? s.w : s.d };
  return { shape: 'poly', points: s.points.map((p) => rotP(p, k)) };
}
const rotLine = (o, k) => ({ ...o, points: o.points.map((p) => rotP(p, k)) });
const rotBridge = (b, k) => ({ ...b, a: rotP(b.a, k), b: rotP(b.b, k) });

/** The item plus its rotated copies. `n` = 2 (180 degrees) or 4 (90 degrees). */
function sym(items, n, rot) {
  const k = 4 / n;
  const outItems = [];
  for (let i = 0; i < n; i++) for (const it of items) outItems.push(rot(it, i * k));
  return outItems;
}
const S = {
  xz: (items, n) => sym(items, n, rotXZ),
  shape: (items, n) => sym(items, n, rotShape),
  line: (items, n) => sym(items, n, rotLine),
  bridge: (items, n) => sym(items, n, rotBridge),
  struct: (items, n) => sym(items, n, (s, k) => ({ ...rotXZ(s, k), rotation: r1(((s.rotation ?? 0) + k * Math.PI / 2) % (2 * Math.PI)) })),
};

/** Irregular polygon around (x, z): `r` radius, `n` corners, `wob` 0..1 jitter (seeded). */
function blob(x, z, r, n = 8, wob = 0.25, seed = 1) {
  const pts = [];
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 - wob + rnd() * wob * 2);
    pts.push([r1(x + Math.cos(a) * rr), r1(z + Math.sin(a) * rr)]);
  }
  return { shape: 'poly', points: pts };
}

const P = (x, z, name, radius) => ({ x, z, name, ...(radius ? { radius } : {}) });
const ROCKS = ['models/env/rock_large_a.glb', 'models/env/rock_large_b.glb', 'models/env/rock_small_a.glb', 'models/env/rock_tall_a.glb', 'models/env/rock_stone_large.glb'];
const BUSHES = ['models/env/bush_small.glb', 'models/env/bush_large.glb', 'models/env/bush_detailed.glb'];
const OIL = ['models/buildings/props/gas_tank.glb', 'models/buildings/props/barrel.glb', 'models/buildings/props/explosive_barrel.glb', 'models/buildings/props/container_02.glb'];

/** Sandbags ring and crates at a capture point (props only). */
function pointDressing(p, k = 0) {
  const props = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + k;
    props.push({ model: 'models/buildings/props/sandbags.glb', x: r1(p.x + Math.cos(a) * 11), z: r1(p.z + Math.sin(a) * 11), rotation: r1(a + Math.PI / 2) });
  }
  props.push({ model: 'models/buildings/props/wooden_box.glb', x: r1(p.x + 4), z: r1(p.z - 3), rotation: 0.4 });
  props.push({ model: 'models/buildings/props/barrel.glb', x: r1(p.x - 3), z: r1(p.z + 5) });
  return props;
}

/** Oil-well clutter at a supply node (props only). */
function nodeDressing(n, i) {
  return [
    { model: OIL[0], x: r1(n.x + 9), z: r1(n.z + 7), rotation: r1(i * 0.7) },
    { model: OIL[1], x: r1(n.x - 8), z: r1(n.z + 9) },
    { model: OIL[2], x: r1(n.x - 9), z: r1(n.z + 7.5) },
    { model: OIL[3], x: r1(n.x + 2), z: r1(n.z - 11), rotation: r1(1.57 + i * 0.3) },
  ];
}

function write(map) {
  map.props = [...(map.props ?? []), ...(map.points ?? []).flatMap((p, i) => pointDressing(p, i * 0.3)), ...(map.supplyNodes ?? []).flatMap(nodeDressing)];
  writeFileSync(join(out, `${map.id}.json`), JSON.stringify(map, null, 1) + '\n');
  console.log(`${map.id}: ${map.points.length} points, ${map.supplyNodes.length} nodes, ${map.spawns.length} spawns`);
}

// --- Valley Pass (1v1) ------------------------------------------------------------------------
// Two plateau bases above a river valley. Each base has two exits (center pass + one flank pass)
// between sheer ridges. Three bridges and two fords cross the river; the Bridge point sits low in
// the middle, overlooked by hills on both banks, so it's easy to take and hard to keep.
write({
  id: 'valley_pass',
  name: 'Valley Pass',
  size: 1100,
  modes: ['1v1'],
  atmosphere: 'golden',
  spawns: S.xz([{ x: 0, z: 430 }], 2),
  sides: [[0], [1]],
  terrain: {
    seed: 11,
    symmetry: 2,
    style: 'temperate',
    base: 6,
    relief: 6,
    detail: 1.2,
    hills: S.xz(
      [
        { x: 0, z: 440, r: 200, h: 12, plateau: 0.55 },
        { x: -170, z: 125, r: 80, h: 20, plateau: 0.35 },
        { x: 440, z: 300, r: 110, h: 15, plateau: 0.3 },
        { x: -470, z: 360, r: 90, h: 24, plateau: 0.2 },
        { x: 260, z: 120, r: 60, h: 9 },
      ],
      2,
    ),
    ridges: S.line(
      [
        { points: [[-560, 235], [-400, 250], [-260, 245], [-150, 258]], width: 30, h: 24, cliff: true },
        { points: [[70, 248], [200, 232], [380, 205]], width: 28, h: 22, cliff: true },
      ],
      2,
    ),
    rivers: [{ points: [[-570, 12], [-330, -18], [-120, 22], [0, 0], [120, -22], [330, 18], [570, -12]], width: 32, depth: 3.2 }],
    fords: S.xz([{ x: -205, z: 7, r: 24 }], 2),
    bridges: [
      { a: [0, -36], b: [0, 36], width: 12 },
      ...S.bridge([{ a: [-330, -54], b: [-330, 18], width: 12 }], 2),
    ],
    forests: S.shape(
      [
        blob(-440, 175, 55, 9, 0.3, 3),
        { shape: 'poly', points: [[-95, 62], [-42, 52], [-30, 98], [-82, 112]] },
        blob(305, 350, 50, 8, 0.3, 5),
        blob(185, 125, 50, 8, 0.25, 7),
        blob(-300, 330, 40, 7, 0.3, 9),
        blob(470, 90, 45, 8, 0.3, 11),
      ],
      2,
    ),
    roads: [
      { points: [[0, 420], [0, 250], [-10, 120], [0, 36], [0, -36], [10, -120], [0, -250], [0, -420]], width: 8 },
      ...S.line([{ points: [[0, 420], [200, 325], [460, 205], [420, 95], [330, 54], [330, -18], [200, -110], [10, -170]], width: 7 }], 2),
      ...S.line([{ points: [[-10, 150], [-200, 90], [-330, -18]], width: 6 }], 2),
    ],
  },
  points: [P(0, 0, 'Bridge', 32), ...S.xz([P(-380, 95, 'West Mill'), P(170, 300, 'Farmstead')], 2).map((p, i) => ({ ...p, name: [`West Mill`, 'South Farm', 'East Mill', 'North Farm'][i] }))],
  supplyNodes: S.xz([{ x: -120, z: 380 }, { x: 130, z: 405 }, { x: -280, z: 145 }, { x: 110, z: 75 }], 2),
  structures: S.struct([{ type: 'ruin', x: -405, z: 125 }, { type: 'ruin', x: 46, z: 58 }, { type: 'ruin', x: 196, z: 322, rotation: 1.5708 }], 2),
  scatter: [
    { models: ROCKS, area: { shape: 'rect', x: 0, z: 0, w: 1100, d: 1100 }, count: 160, scale: [0.6, 1.6] },
    { models: BUSHES, area: { shape: 'rect', x: 0, z: 0, w: 1100, d: 1100 }, count: 420, scale: [0.8, 1.6] },
  ],
});

// --- Coastal Strait (2v2) ---------------------------------------------------------------------
// Two mainland coasts across a strait. The Lighthouse island in the middle is reached over two
// long bridges (chokepoints, and naval guns cover the whole island). The west and east isles are
// only reachable by transport ship or helicopter: amphibious landings decide them.
const coastIslands = [blob(0, 0, 118, 10, 0.12, 2), blob(-430, 12, 100, 9, 0.2, 4), blob(430, -12, 100, 9, 0.2, 4)];
coastIslands[2] = rotShape(coastIslands[1], 2);
write({
  id: 'coastal_strait',
  name: 'Coastal Strait',
  size: 1200,
  modes: ['2v2', '1v1'],
  atmosphere: 'overcast',
  spawns: [
    { x: -300, z: 445 },
    { x: 300, z: 445 },
    { x: 300, z: -445 },
    { x: -300, z: -445 },
  ],
  sides: [
    [0, 1],
    [2, 3],
  ],
  terrain: {
    seed: 23,
    symmetry: 2,
    style: 'coastal',
    base: 6,
    relief: 7,
    detail: 1,
    water: [{ shape: 'rect', x: 0, z: 0, w: 1200, d: 460 }],
    islands: coastIslands,
    hills: S.xz(
      [
        { x: 0, z: 0, r: 90, h: 14, plateau: 0.3 },
        { x: -445, z: 25, r: 70, h: 9 },
        { x: -150, z: 315, r: 90, h: 14, plateau: 0.3 },
        { x: 440, z: 340, r: 100, h: 18, plateau: 0.4 },
        { x: -520, z: 470, r: 120, h: 20 },
      ],
      2,
    ).filter((h, i, all) => all.findIndex((o) => o.x === h.x && o.z === h.z) === i),
    cliffs: S.shape([blob(-40, 380, 22, 7, 0.3, 13), blob(200, 520, 30, 7, 0.3, 17)], 2),
    bridges: S.bridge([{ a: [0, 96], b: [0, 246], width: 13 }], 2),
    forests: S.shape(
      [
        blob(-470, 330, 60, 9, 0.3, 21),
        blob(170, 330, 55, 8, 0.3, 23),
        blob(-210, 470, 50, 8, 0.3, 25),
        blob(-420, -10, 35, 7, 0.3, 27),
        blob(520, 420, 45, 8, 0.3, 29),
      ],
      2,
    ),
    roads: [
      ...S.line(
        [
          { points: [[-300, 430], [-150, 385], [0, 340], [0, 246]], width: 7 },
          { points: [[300, 430], [150, 385], [0, 340]], width: 7 },
          { points: [[-560, 300], [-380, 315], [-180, 345], [0, 340], [190, 340], [380, 320], [560, 300]], width: 6 },
        ],
        2,
      ),
      { points: [[0, 96], [0, 40], [0, -40], [0, -96]], width: 7 },
    ],
  },
  points: [
    P(0, 0, 'Lighthouse', 30),
    ...S.xz([P(-430, 15, 'West Isle'), P(-380, 300, 'Harbor'), P(380, 320, 'Cannery')], 2).map((p, i) => ({ ...p, name: ['West Isle', 'South Harbor', 'South Cannery', 'East Isle', 'North Harbor', 'North Cannery'][i] })),
  ],
  supplyNodes: S.xz([{ x: -170, z: 430 }, { x: 170, z: 430 }, { x: -300, z: 280 }, { x: 300, z: 300 }, { x: -400, z: 45 }, { x: 40, z: 32 }], 2),
  structures: S.struct([{ type: 'ruin', x: -350, z: 330 }, { type: 'ruin', x: 410, z: 290, rotation: 1.5708 }, { type: 'ruin', x: -455, z: -12 }, { type: 'ruin', x: 30, z: -40 }], 2),
  scatter: [
    { models: ROCKS, area: { shape: 'rect', x: 0, z: 400, w: 1200, d: 340 }, count: 90, scale: [0.6, 1.5] },
    { models: ROCKS, area: { shape: 'rect', x: 0, z: -400, w: 1200, d: 340 }, count: 90, scale: [0.6, 1.5] },
    { models: BUSHES, area: { shape: 'rect', x: 0, z: 400, w: 1200, d: 340 }, count: 220, scale: [0.8, 1.5] },
    { models: BUSHES, area: { shape: 'rect', x: 0, z: -400, w: 1200, d: 340 }, count: 220, scale: [0.8, 1.5] },
  ],
});

// --- Desert Oilfields (1v1 / 2v2 / 4-player FFA) ---------------------------------------------
// Open dunes for armor. Four mesas split the middle into four lanes; the Oilfield sits in a basin
// overlooked from every lane. Each mid point has a plateau on one side to fight from, and there are
// supply nodes (oil wells) everywhere. Four-fold symmetric for free-for-all.
const dSpawn = { x: -440, z: 440 };
write({
  id: 'desert_oilfields',
  name: 'Desert Oilfields',
  size: 1200,
  modes: ['1v1', '2v2', 'ffa4'],
  atmosphere: 'noon',
  // Spawn order SW, NE, NW, SE: 1v1 is diagonal, FFA takes one corner each.
  spawns: [dSpawn, rotXZ(dSpawn, 2), rotXZ(dSpawn, 1), rotXZ(dSpawn, 3)].map(({ x, z }) => ({ x, z })),
  sides: [
    [0, 3],
    [1, 2],
  ],
  terrain: {
    seed: 37,
    symmetry: 4,
    style: 'desert',
    base: 7,
    relief: 5,
    detail: 1.6,
    hills: [
      { x: 0, z: 0, r: 150, h: -5, plateau: 0.45 },
      ...S.xz(
        [
          { x: 125, z: 365, r: 72, h: 14, plateau: 0.5 },
          { x: -420, z: 420, r: 130, h: 6, plateau: 0.6 },
          { x: -150, z: 520, r: 80, h: 16 },
        ],
        4,
      ),
    ],
    cliffs: S.shape([blob(235, 235, 58, 9, 0.25, 31), blob(-270, 470, 24, 7, 0.3, 33), blob(60, 160, 14, 6, 0.3, 35), blob(-90, 300, 16, 6, 0.3, 37)], 4),
    ridges: S.line([{ points: [[-560, 180], [-470, 230], [-400, 210]], width: 40, h: 12 }], 4),
    forests: S.shape([blob(-75, 365, 32, 7, 0.3, 41)], 4),
    roads: S.line(
      [
        { points: [[-440, 440], [-300, 300], [-140, 330], [0, 330]], width: 7 },
        { points: [[-300, 300], [-330, 140], [-330, 0]], width: 7 },
        { points: [[0, 330], [0, 150], [0, 0]], width: 8 },
      ],
      4,
    ),
  },
  points: [P(0, 0, 'Oilfield', 34), ...S.xz([P(0, 330, 'Pumping Station'), P(-300, 300, 'Depot')], 4).map((p, i) => ({ ...p, name: ['South Station', 'SW Depot', 'West Station', 'NW Depot', 'North Station', 'NE Depot', 'East Station', 'SE Depot'][i] }))],
  supplyNodes: [...S.xz([{ x: -360, z: 330 }, { x: -320, z: 380 }, { x: 60, z: 360 }, { x: -60, z: 300 }], 4), ...S.xz([{ x: 45, z: 45 }], 4)],
  structures: S.struct([{ type: 'ruin', x: 30, z: 305 }, { type: 'ruin', x: -275, z: 280, rotation: 1.5708 }], 4),
  scatter: [
    { models: ROCKS, area: { shape: 'rect', x: 0, z: 0, w: 1200, d: 1200 }, count: 260, scale: [0.6, 2] },
    { models: ['models/env/bush_small.glb', 'models/env/tree_stump.glb'], area: { shape: 'rect', x: 0, z: 0, w: 1200, d: 1200 }, count: 120, scale: [0.6, 1.2] },
  ],
});
