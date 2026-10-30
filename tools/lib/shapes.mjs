// Flat-shaded primitive meshes for kitbashed buildings (slabs, pillars, crane beams, hangars).

import { Document } from '@gltf-transform/core';

function hexColor(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  // sRGB hex -> linear baseColorFactor.
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}
export { hexColor };

// Triangles as flat lists of [x,y,z] corners; normals come from the winding.
function boxTris(w, h, d) {
  const x = w / 2, z = d / 2;
  const p = [[-x, 0, -z], [x, 0, -z], [x, h, -z], [-x, h, -z], [-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]];
  const quads = [[4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [7, 6, 2, 3], [0, 1, 5, 4]];
  return quads.flatMap(([a, b, c, e]) => [p[a], p[b], p[c], p[a], p[c], p[e]]);
}

function cylinderTris(rBottom, rTop, h, seg) {
  const tris = [];
  const ring = (r, y) => Array.from({ length: seg }, (_, i) => {
    const a = (i / seg) * Math.PI * 2;
    return [Math.sin(a) * r, y, Math.cos(a) * r];
  });
  const lo = ring(rBottom, 0), hi = ring(rTop, h);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    tris.push(lo[i], lo[j], hi[j], lo[i], hi[j], hi[i]);
    tris.push([0, h, 0], hi[i], hi[j]);
    tris.push([0, 0, 0], lo[j], lo[i]);
  }
  return tris;
}

// Half cylinder lying along Z (a Quonset hangar roof), width w, length d.
function archTris(w, d, seg) {
  const tris = [];
  const r = w / 2, z = d / 2;
  const pt = (i, zz) => {
    const a = Math.PI - (i / seg) * Math.PI;
    return [Math.cos(a) * r, Math.sin(a) * r, zz];
  };
  for (let i = 0; i < seg; i++) {
    tris.push(pt(i, -z), pt(i + 1, -z), pt(i + 1, z), pt(i, -z), pt(i + 1, z), pt(i, z));
    tris.push([0, 0, z], pt(i + 1, z), pt(i, z));
    tris.push([0, 0, -z], pt(i, -z), pt(i + 1, -z));
  }
  return tris;
}

/** Builds a one-node Document for a shape part spec: { box: [w,h,d] } | { cylinder: [rBottom, rTop, h] } | { arch: [w, d] }. */
export function shapeDocument(spec) {
  let tris;
  if (spec.box) tris = boxTris(...spec.box);
  else if (spec.cylinder) tris = cylinderTris(...spec.cylinder, spec.segments ?? 16);
  else if (spec.arch) tris = archTris(...spec.arch, spec.segments ?? 12);
  else throw new Error(`unknown shape ${JSON.stringify(spec)}`);

  const pos = [], nrm = [];
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = tris.slice(i, i + 3);
    const u = b.map((q, k) => q - a[k]), w = c.map((q, k) => q - a[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    for (const p of [a, b, c]) {
      pos.push(...p);
      nrm.push(n[0] / l, n[1] / l, n[2] / l);
    }
  }
  const doc = new Document();
  const buf = doc.createBuffer();
  const name = spec.name ?? 'shape';
  const mat = doc.createMaterial(spec.material ?? name).setBaseColorFactor([...hexColor(spec.color ?? '#888888'), 1])
    .setRoughnessFactor(spec.roughness ?? 0.9).setMetallicFactor(spec.metallic ?? 0).setDoubleSided(true);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setBuffer(buf).setType('VEC3').setArray(new Float32Array(pos)))
    .setAttribute('NORMAL', doc.createAccessor().setBuffer(buf).setType('VEC3').setArray(new Float32Array(nrm)));
  doc.createScene().addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  return doc;
}
