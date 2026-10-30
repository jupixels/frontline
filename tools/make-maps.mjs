// Generates the launch maps in data/maps/ from compact, symmetric descriptions.
//   node tools/make-maps.mjs
// Two-sided maps use 180-degree rotational symmetry, the four-corner map uses 90-degree symmetry and the
// eight-player map adds a mirror across x = z (eight-fold),
// so every side gets exactly the same ground. Edit this file, not the JSON.

import { readFileSync, writeFileSync } from 'node:fs';
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

/** Sandbag walls facing outward from the map center, crates and a barrel at a capture point (props only). */
function pointDressing(p) {
  const props = [];
  // Facing away from the middle keeps twin points identical under the map's symmetry.
  const out = p.x || p.z ? Math.atan2(p.z, p.x) : 0;
  for (const arc of [out, out + Math.PI]) {
    for (let i = -2; i <= 2; i++) {
      const a = arc + i * 0.2;
      props.push({ model: DRESS.sandbagWall, x: r1(p.x + Math.cos(a) * 13), z: r1(p.z + Math.sin(a) * 13), rotation: r1(Math.PI / 2 - a) });
    }
  }
  for (const side of [-1, 1]) {
    const a = out + side * Math.PI / 2;
    props.push({ model: DRESS.sandbagWall, x: r1(p.x + Math.cos(a) * 15), z: r1(p.z + Math.sin(a) * 15), rotation: r1(Math.PI / 2 - a) });
  }
  props.push({ model: 'models/buildings/props/wooden_box.glb', x: r1(p.x + Math.cos(out + 0.6) * 6), z: r1(p.z + Math.sin(out + 0.6) * 6), rotation: 0.4 });
  props.push({ model: 'models/buildings/props/barrel.glb', x: r1(p.x + Math.cos(out - 2.4) * 6), z: r1(p.z + Math.sin(out - 2.4) * 6) });
  return props;
}

// --- dressing (render only: the sim never reads `dressing` or props) ---------------------------
// Placeholders until the models session's Meshy props land: swap the paths here and regenerate.
const DRESS = {
  sandbagWall: 'models/buildings/props/sandbags.glb',
  ruinedWall: 'models/buildings/props/wall_02.glb',
  fuelTank: 'models/buildings/props/gas_tank.glb',
  barrier: 'models/buildings/props/barrier.glb',
  block: 'models/buildings/props/concrete_block.glb',
  lamp: 'models/buildings/props/light_pole.glb',
  containers: ['models/buildings/props/container_01.glb', 'models/buildings/props/container_02.glb', 'models/buildings/props/container_03.glb'],
};
/** Burnt-out vehicles reuse the unit models, drawn charred. */
const wreck = (unit, x, z, rotation) => ({ model: `models/${unit}.glb`, x, z, rotation, burnt: true });
const prop = (model, x, z, rotation = 0) => ({ model, x, z, rotation });

const TAU = Math.PI * 2;
const wrap = (a) => r1(((a % TAU) + TAU) % TAU);
/** Areas and props turn with the map: a quarter turn of the position is -90 degrees of heading. */
const rotArea = (a, k) => ({ ...rotXZ(a, k), rotation: wrap((a.rotation ?? 0) - (k * Math.PI) / 2) });
const mirArea = (a) => ({ ...a, x: a.z, z: a.x, rotation: wrap(Math.PI / 2 - (a.rotation ?? 0)) });
S.area = (items, n) => sym(items, n, rotArea);

/** A field `w` x `d` meters turned by `rotation`. */
const field = (x, z, w, d, rotation, crop) => ({ x, z, w, d, rotation, crop });
/** The field's edge as a line of `kind`, leaving a gate in the middle of the near (-z) side. */
function around(f, kind) {
  const c = Math.cos(f.rotation ?? 0);
  const s = Math.sin(f.rotation ?? 0);
  const at = (lx, lz) => [r1(f.x + lx * c + lz * s), r1(f.z - lx * s + lz * c)];
  const w = f.w / 2 + 2;
  const d = f.d / 2 + 2;
  return { kind, points: [at(-4, -d), at(-w, -d), at(-w, d), at(w, d), at(w, -d), at(4, -d)] };
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
  map.props = [...(map.props ?? []), ...(map.points ?? []).flatMap((p) => pointDressing(p)), ...(map.supplyNodes ?? []).flatMap(nodeDressing)];
  writeFileSync(join(out, `${map.id}.json`), JSON.stringify(map, null, 1) + '\n');
  console.log(`${map.id}: ${map.points.length} points, ${map.supplyNodes.length} nodes, ${map.spawns.length} spawns`);
}

// --- Valley Pass (1v1) ------------------------------------------------------------------------
const VALLEY_FIELDS = [
  field(90, 175, 70, 45, 0.1, 'wheat'),
  field(330, 150, 60, 40, -0.2, 'green'),
  field(-310, 175, 60, 40, 0.15, 'furrow'),
  field(-300, 110, 50, 35, 0.4, 'wheat'),
  field(-180, 330, 50, 40, -0.1, 'green'),
];
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
  dressing: {
    fields: S.area(VALLEY_FIELDS, 2),
    lines: [
      ...S.line(VALLEY_FIELDS.map((f, i) => around(f, i % 2 ? 'fence' : 'wall')), 2),
      // Power down the valley road to the river bank, and on to the West Mill.
      ...S.line([{ kind: 'power', points: [[16, 250], [8, 150], [40, 40]] }, { kind: 'power', points: [[8, 150], [-120, 122], [-250, 100]] }], 2),
    ],
  },
  props: S.area(
    [
      wreck('tank_mbt', 40, 82, 2.6),
      wreck('jeep', -60, 190, 1.2),
      wreck('supply_truck', 232, 50, 0.4),
      wreck('tank_light', -215, 50, 2.3),
      prop(DRESS.ruinedWall, 215, 300),
      prop(DRESS.ruinedWall, 182, 345, 1.57),
      prop(DRESS.ruinedWall, -430, 105, 0.3),
      prop(DRESS.ruinedWall, -386, 146, 1.2),
    ],
    2,
  ),
  scatter: [
    { models: ROCKS, area: { shape: 'rect', x: 0, z: 0, w: 1100, d: 1100 }, count: 160, scale: [0.6, 1.6] },
    { models: BUSHES, area: { shape: 'rect', x: 0, z: 0, w: 1100, d: 1100 }, count: 420, scale: [0.8, 1.6] },
  ],
});

// --- Coastal Strait (2v2) ---------------------------------------------------------------------
const COAST_FIELDS = [field(-150, 300, 60, 40, 0.2, 'green'), field(75, 290, 50, 35, 0, 'furrow')];
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
  atmosphere: 'rain',
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
  dressing: {
    fields: S.area(COAST_FIELDS, 2),
    lines: [...S.line(COAST_FIELDS.map((f) => around(f, 'wall')), 2), ...S.line([{ kind: 'power', points: [[-150, 372], [-14, 322], [150, 372]] }], 2)],
    // Piers run from the beach (+z end) out over the water.
    docks: S.area([{ x: -380, z: 236, w: 8, d: 40, rotation: 0 }, { x: -335, z: 232, w: 6, d: 28, rotation: 0 }, { x: 400, z: 234, w: 10, d: 36, rotation: 0 }], 2),
  },
  props: S.area(
    [
      prop(DRESS.containers[0], 445, 262),
      prop(DRESS.containers[1], 445, 266.5),
      prop(DRESS.containers[2], 428, 250, 1.57),
      prop(DRESS.fuelTank, 350, 268, 1.57),
      prop(DRESS.fuelTank, 358, 268, 1.57),
      prop(DRESS.lamp, -372, 258),
      prop(DRESS.lamp, 392, 256),
      prop(DRESS.lamp, 40, 30),
      wreck('tank_light', 40, 252, 1),
      wreck('supply_truck', -250, 245, 2.2),
      wreck('jeep', 250, 250, 0.5),
      wreck('ifv', -410, 50, 2),
    ],
    2,
  ),
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
  atmosphere: 'haze',
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
  dressing: {
    lines: S.line(
      [
        { kind: 'pipe', points: [[-318, 268], [-348, 140], [-348, 30]] },
        { kind: 'pipe', points: [[-60, 300], [-42, 312], [-28, 312]] },
        { kind: 'power', points: [[14, 300], [14, 150], [14, 42]] },
      ],
      4,
    ),
  },
  props: S.area(
    [
      prop(DRESS.fuelTank, -350, 250, 1.57),
      prop(DRESS.fuelTank, -358, 250, 1.57),
      prop(DRESS.fuelTank, -366, 250, 1.57),
      prop(DRESS.fuelTank, 82, 18, 0.8),
      prop(DRESS.barrier, 30, 300),
      prop(DRESS.barrier, -30, 300),
      prop(DRESS.block, 0, 296),
      wreck('tank_mbt', -162, 350, 1.9),
      wreck('supply_truck', -352, 108, 0.1),
      wreck('jeep', -120, 150, 2.5),
    ],
    4,
  ),
  scatter: [
    { models: ROCKS, area: { shape: 'rect', x: 0, z: 0, w: 1200, d: 1200 }, count: 260, scale: [0.6, 2] },
    { models: ['models/env/bush_small.glb', 'models/env/tree_stump.glb'], area: { shape: 'rect', x: 0, z: 0, w: 1200, d: 1200 }, count: 120, scale: [0.6, 1.2] },
  ],
});

// --- eight-fold helpers (quarter turns + mirror across x = z) -----------------------------------

const mirP = ([x, z]) => [z, x];
const mirXZ = (o) => ({ ...o, x: o.z, z: o.x });
function mirShape(s) {
  if (s.shape === 'circle') return mirXZ(s);
  if (s.shape === 'rect') return { ...mirXZ(s), w: s.d, d: s.w };
  return { shape: 'poly', points: s.points.map(mirP).reverse() };
}
const mirLine = (o) => ({ ...o, points: o.points.map(mirP) });
const mirBridge = (b) => ({ ...b, a: mirP(b.a), b: mirP(b.b) });
const rotStruct = (s, k) => ({ ...rotXZ(s, k), rotation: r1(((s.rotation ?? 0) + k * Math.PI / 2) % (2 * Math.PI)) });
const mirStruct = (s) => ({ ...mirXZ(s), rotation: r1((Math.PI / 2 - (s.rotation ?? 0) + 2 * Math.PI) % (2 * Math.PI)) });

/** The items, their mirror images and the quarter-turn copies of both, without duplicates (items on an axis). */
function sym8(items, rot, mir) {
  const outItems = [];
  const seen = new Set();
  for (const it of items) {
    for (const base of [it, mir(it)]) {
      for (let k = 0; k < 4; k++) {
        const c = rot(base, k);
        const key = JSON.stringify(c.points ? { ...c, points: c.points.map(String).sort() } : c);
        if (seen.has(key)) continue;
        seen.add(key);
        outItems.push(c);
      }
    }
  }
  return outItems;
}
const S8 = {
  area: (items) => sym8(items, rotArea, mirArea),
  xz: (items) => sym8(items, rotXZ, mirXZ),
  shape: (items) => sym8(items, rotShape, mirShape),
  line: (items) => sym8(items, rotLine, mirLine),
  bridge: (items) => sym8(items, rotBridge, mirBridge),
  struct: (items) => sym8(items, rotStruct, mirStruct),
};

const DEG = Math.PI / 180;
/** [x, z] at radius `r`, `a` degrees from +x toward +z. */
const pol = (r, a) => [r1(r * Math.cos(a * DEG)), r1(r * Math.sin(a * DEG))];
const xz = ([x, z]) => ({ x, z });
/** On the x = z diagonal exactly, so the mirror maps it onto itself. */
const diag = (r) => [r1(r / Math.SQRT2), r1(r / Math.SQRT2)];

/**
 * Closed outline whose radius follows `R(degrees)` (which must be eight-fold symmetric itself), built
 * from one octant and copied exactly, so rounding can't break the symmetry.
 */
function ring8(R, perOctant = 12) {
  const oct = [];
  for (let j = 0; j <= perOctant; j++) {
    const a = (j / perOctant) * 45;
    oct.push(j === perOctant ? diag(R(a)) : pol(R(a), a));
  }
  const quarter = [...oct, ...oct.slice(1, -1).reverse().map(mirP)];
  return { shape: 'poly', points: [0, 1, 2, 3].flatMap((k) => quarter.map((p) => rotP(p, k))) };
}

/** Compass name for a position (+x east, +z south, like the other maps). */
function compass(x, z) {
  const a = (Math.atan2(-z, x) / DEG + 360) % 360;
  return ['East', 'NE', 'North', 'NW', 'West', 'SW', 'South', 'SE'][Math.round(a / 45) % 8];
}

// --- Inland Sea (8 players: 4v4, 8-player FFA, and smaller) -----------------------------------
// Eight coastal bases ring an inland sea, each with its own inlet for a naval yard. The sea holds the
// Citadel Isle (ships, transports and helicopters only) and four bridged isles; four lighthouse
// headlands jut into the water between neighbors, in reach of naval guns. Inland, four high ridges in
// the corners are pure land fights. 4v4 splits west against east, so the north and south lighthouses
// and the Citadel are the front. Eight-fold symmetric: every spawn gets the same ground.
{
  const home = pol(680, 22.5);
  const twin = mirP(home);
  const seaR = (a) => {
    const c = Math.cos(8 * a * DEG);
    return 450 - 60 * c + 95 * Math.max(0, -c) ** 4;
  };
  const isle = diag(250);
  const ridge = diag(800);
  const fields = [field(520, 0, 56, 40, Math.PI / 2, 'green'), field(790, 0, 70, 46, Math.PI / 2, 'furrow')];
  write({
    id: 'inland_sea',
    name: 'Inland Sea',
    size: 1800,
    modes: ['4v4', '3v3', '2v2', '1v1', 'ffa8', 'ffa4'],
    atmosphere: 'windy',
    // Order: 1v1 opposite, FFA4 every other base, then the rest. Sides: east half against west half,
    // teammates filling outward from the middle of their coast.
    spawns: [rotP(home, 0), rotP(home, 2), rotP(home, 1), rotP(home, 3), rotP(twin, 0), rotP(twin, 2), rotP(twin, 1), rotP(twin, 3)].map(xz),
    sides: [
      [0, 7, 4, 3],
      [1, 6, 5, 2],
    ],
    terrain: {
      seed: 53,
      symmetry: 8,
      style: 'coastal',
      base: 6,
      relief: 5,
      detail: 1,
      water: [ring8(seaR)],
      islands: [{ shape: 'circle', x: 0, z: 0, r: 115 }, ...S8.shape([{ shape: 'circle', ...xz(isle), r: 66 }])],
      hills: [
        { x: 0, z: 0, r: 85, h: 9, plateau: 0.4 },
        ...S8.xz([
          { ...xz(home), r: 120, h: 5, plateau: 0.6 },
          { ...xz(ridge), r: 130, h: 15, plateau: 0.45 },
          { x: 455, z: 0, r: 70, h: 7, plateau: 0.4 },
          { ...xz(isle), r: 50, h: 5, plateau: 0.3 },
          { ...xz(pol(840, 8)), r: 110, h: 16 },
        ]),
      ],
      cliffs: S8.shape([blob(...pol(560, 39), 26, 7, 0.3, 61), blob(...pol(760, 14), 20, 6, 0.3, 63)]),
      bridges: S8.bridge([{ a: diag(418), b: diag(304), width: 12 }]),
      forests: S8.shape([{ shape: 'circle', x: 700, z: 0, r: 48 }, blob(...pol(830, 31), 42, 8, 0.3, 65), blob(...pol(600, 6), 30, 7, 0.3, 67)]),
      roads: S8.line([
        { points: [home, pol(560, 10), [440, 0]], width: 7 },
        { points: [home, pol(520, 33), diag(418), diag(304), isle], width: 7 },
        { points: [home, pol(770, 34), ridge], width: 7 },
        { points: [home, pol(730, 8), [745, 0]], width: 6 },
      ]),
    },
    points: [
      P(0, 0, 'Citadel Isle', 34),
      ...S8.xz([{ x: 435, z: 0 }]).map((p) => ({ ...p, name: `${compass(p.x, p.z)} Lighthouse` })),
      ...S8.xz([xz(isle)]).map((p) => ({ ...p, name: `${compass(p.x, p.z)} Isle` })),
      ...S8.xz([xz(ridge)]).map((p) => ({ ...p, name: `${compass(p.x, p.z)} Ridge` })),
    ],
    supplyNodes: S8.xz([xz(pol(770, 17)), xz(pol(700, 31)), xz(pol(480, 7)), xz(pol(255, 49)), xz(diag(850)), xz(diag(60))]),
    structures: S8.struct([{ type: 'ruin', x: 465, z: 0 }, { type: 'ruin', ...xz(diag(770)) }, { type: 'ruin', x: 0, z: 40 }]),
    dressing: {
      // Items on an axis face along it (rotation pi/2) so their mirror image is their own rotated copy.
      fields: S8.area(fields),
      lines: S8.line(fields.map((f, i) => around(f, i ? 'wall' : 'fence'))),
      docks: S8.area([{ x: 378, z: 0, w: 7, d: 30, rotation: Math.PI / 2 }]),
    },
    props: S8.area([
      prop(DRESS.containers[0], 420, 40, Math.PI / 2),
      prop(DRESS.lamp, 398, 8),
      wreck('tank_mbt', ...pol(760, 47), 1),
      wreck('ifv', ...pol(700, 51), 2.2),
      prop(DRESS.ruinedWall, ...pol(790, 41), 0.6),
      prop(DRESS.ruinedWall, ...pol(812, 44), 2.1),
    ]),
    scatter: [
      { models: ROCKS, area: { shape: 'rect', x: 0, z: 0, w: 1800, d: 1800 }, count: 320, scale: [0.6, 1.6] },
      { models: BUSHES, area: { shape: 'rect', x: 0, z: 0, w: 1800, d: 1800 }, count: 560, scale: [0.8, 1.5] },
    ],
  });
}

// --- Iron Gulf (6 players: 3v3, and smaller) -------------------------------------------------
// Two coasts face each other across a gulf, three bases each, every one with its own inlet. The land
// war runs over the two isthmuses that close the gulf at east and west (each split into two lanes by
// rock); the sea war is for Fortress Isle (no bridge), the two bridged side isles and the coves between
// the bases, which ships can shell. Each coast's middle base is its naval anchor; the flank bases sit
// on the isthmus roads. 180-degree symmetric.
{
  const SZ = -640;
  const fields = [field(-230, -760, 60, 40, 0, 'wheat'), field(230, -760, 60, 40, 0, 'furrow')];
  const southCoast = [];
  for (let x = -590; x <= 590; x += 29.5) southCoast.push([r1(x), r1(-395 + 16 * Math.cos(x / 70) + 10 * Math.cos(x / 31 + 1))]);
  // East shore from the south coast's end up to where the rotated south coast (the north coast) begins.
  const z0 = southCoast[southCoast.length - 1][1];
  const z1 = -southCoast[0][1];
  const eastShore = [];
  for (let i = 1; i < 16; i++) {
    const t = i / 16;
    const z = z0 + (z1 - z0) * t;
    eastShore.push([r1(590 - 45 * Math.sin(Math.PI * t) + 8 * Math.cos(z / 23)), r1(z)]);
  }
  const half = [...southCoast, ...eastShore];
  const gulf = { shape: 'poly', points: [...half, ...half.map((p) => rotP(p, 2))] };
  const fortressHalf = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = 112 * (1 + 0.12 * Math.cos(i * 2.3 + 1));
    fortressHalf.push([r1(Math.cos(a) * r), r1(Math.sin(a) * r)]);
  }
  const fortress = { shape: 'poly', points: [...fortressHalf, ...fortressHalf.map((p) => rotP(p, 2))] };
  write({
    id: 'iron_gulf',
    name: 'Iron Gulf',
    size: 1700,
    modes: ['3v3', '2v2', '1v1', 'ffa6'],
    atmosphere: 'dusk',
    // Order: the middle bases first (1v1 is middle against middle), then the flanks in twin pairs.
    spawns: S.xz([{ x: 0, z: SZ }], 2).concat(S.xz([{ x: -460, z: SZ }], 2), S.xz([{ x: 460, z: SZ }], 2)),
    sides: [
      [0, 2, 4],
      [1, 3, 5],
    ],
    terrain: {
      seed: 71,
      symmetry: 2,
      style: 'coastal',
      base: 6,
      relief: 6,
      detail: 1.1,
      // Each base's inlet: a basin for the yard and a mouth opening onto the gulf.
      water: [gulf, ...S.shape([-460, 0, 460].flatMap((x) => [{ shape: 'circle', x, z: -488, r: 66 }, { shape: 'circle', x, z: -405, r: 60 }]), 2)],
      islands: [fortress, ...S.shape([blob(-400, 30, 74, 9, 0.15, 73)], 2)],
      hills: [
        { x: 0, z: 0, r: 85, h: 9, plateau: 0.4 },
        ...S.xz(
          [
            { x: 0, z: SZ, r: 120, h: 5, plateau: 0.6 },
            { x: -460, z: SZ, r: 120, h: 5, plateau: 0.6 },
            { x: 460, z: SZ, r: 120, h: 5, plateau: 0.6 },
            { x: -705, z: 0, r: 110, h: 11, plateau: 0.45 },
            { x: -230, z: -445, r: 60, h: 6, plateau: 0.4 },
            { x: 230, z: -445, r: 60, h: 6, plateau: 0.4 },
            { x: -400, z: 30, r: 50, h: 5, plateau: 0.3 },
            { x: -250, z: -770, r: 90, h: 14 },
          ],
          2,
        ),
      ],
      cliffs: S.shape([blob(-715, -235, 38, 8, 0.3, 75), blob(-715, 235, 38, 8, 0.3, 77), blob(-225, -565, 18, 6, 0.3, 79)], 2),
      bridges: S.bridge([{ a: [-562, 30], b: [-466, 30], width: 12 }], 2),
      forests: S.shape([blob(-640, -470, 45, 8, 0.3, 81), blob(-780, 120, 40, 8, 0.3, 83), blob(230, -560, 35, 7, 0.3, 85), blob(-600, 300, 32, 7, 0.3, 87)], 2),
      roads: S.line(
        [
          { points: [[-460, SZ], [-230, -600], [0, SZ], [230, -600], [460, SZ]], width: 7 },
          { points: [[-460, SZ], [-640, -420], [-650, -235], [-705, 0], [-650, 235], [-640, 420], [-460, -SZ]], width: 7 },
          { points: [[-705, 0], [-562, 30], [-466, 30], [-400, 30]], width: 7 },
          { points: [[-230, -600], [-230, -445]], width: 6 },
          { points: [[230, -600], [230, -445]], width: 6 },
        ],
        2,
      ),
    },
    points: [
      P(0, 0, 'Fortress Isle', 34),
      ...S.xz([P(-400, 30, 'Isle'), P(-705, 0, 'Isthmus'), P(-230, -445, 'Cove'), P(230, -445, 'Cove')], 2).map((p) => ({ ...p, name: `${compass(p.x, p.z)} ${p.name}` })),
    ],
    supplyNodes: [
      ...S.xz(
        [
          { x: -90, z: -715 },
          { x: 90, z: -715 },
          { x: -560, z: -720 },
          { x: -380, z: -730 },
          { x: 380, z: -730 },
          { x: 560, z: -720 },
          { x: -430, z: 70 },
          { x: -370, z: -10 },
          { x: -720, z: -90 },
          { x: -690, z: 90 },
          { x: -230, z: -485 },
          { x: 230, z: -485 },
        ],
        2,
      ),
      { x: 40, z: 30 },
      { x: -40, z: -30 },
    ],
    dressing: {
      fields: S.area(fields, 2),
      lines: [
        ...S.line(fields.map((f) => around(f, 'wall')), 2),
        ...S.line(
          [
            { kind: 'pipe', points: [[-612, -380], [-618, -120], [-615, 120], [-612, 255]] },
            { kind: 'power', points: [[-625, -420], [-628, -235], [-680, -30]] },
          ],
          2,
        ),
      ],
      // Jetties from the coves out into the gulf (+z is the water on this coast).
      docks: S.area([{ x: -230, z: -392, w: 7, d: 30, rotation: Math.PI }, { x: 230, z: -405, w: 7, d: 30, rotation: Math.PI }], 2),
    },
    props: S.area(
      [
        prop(DRESS.fuelTank, -780, -340),
        prop(DRESS.fuelTank, -780, -335),
        prop(DRESS.fuelTank, -780, -330),
        prop(DRESS.fuelTank, -765, -352, 1.57),
        prop(DRESS.containers[0], -200, -425),
        prop(DRESS.containers[2], 258, -428, 1.57),
        prop(DRESS.ruinedWall, -255, -470, 0.2),
        prop(DRESS.ruinedWall, 205, -472, 1.4),
        wreck('tank_mbt', -700, -150, 0.3),
        wreck('ifv', -740, 85, 2),
        wreck('jeep', -665, -335, 1.1),
      ],
      2,
    ),
    structures: [
      ...S.struct([{ type: 'ruin', x: -680, z: -40 }, { type: 'ruin', x: -255, z: -455 }, { type: 'ruin', x: 205, z: -455, rotation: 1.5708 }, { type: 'ruin', x: -420, z: 50 }], 2),
      { type: 'ruin', x: 20, z: -40 },
      { type: 'ruin', x: -20, z: 40 },
    ],
    scatter: [
      { models: ROCKS, area: { shape: 'rect', x: 0, z: 0, w: 1700, d: 1700 }, count: 280, scale: [0.6, 1.6] },
      { models: BUSHES, area: { shape: 'rect', x: 0, z: 0, w: 1700, d: 1700 }, count: 520, scale: [0.8, 1.5] },
    ],
  });
}

// --- Sandbox (hand-made test map): light dressing only -------------------------------------------
{
  const file = join(out, 'sandbox.json');
  const map = JSON.parse(readFileSync(file, 'utf8'));
  map.props = [
    ...map.points.flatMap((p) => pointDressing(p)),
    ...S.area([wreck('tank_light', 0, 88, 1.57), prop(DRESS.barrier, -100, 40, 1.57), prop(DRESS.block, -96, 30, 0.3)], 2),
  ];
  writeFileSync(file, JSON.stringify(map, null, 1) + '\n');
  console.log(`sandbox: ${map.props.length} props`);
}
