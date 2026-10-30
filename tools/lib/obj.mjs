// Minimal Wavefront OBJ + MTL reader that builds a glTF-Transform Document. Enough for the
// low-poly packs we use (flat colors from Kd, optional map_Kd), so the pipeline needs no Blender.

import { Document } from '@gltf-transform/core';

function parseMtl(text) {
  const mats = new Map();
  let cur;
  for (const line of text.split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'newmtl') mats.set(rest.join(' '), (cur = { kd: [0.8, 0.8, 0.8], d: 1 }));
    else if (!cur) continue;
    else if (k === 'Kd') cur.kd = rest.slice(0, 3).map(Number);
    else if (k === 'd') cur.d = Number(rest[0]);
    else if (k === 'map_Kd') cur.map = rest.join(' ').replaceAll('\\', '/');
  }
  return mats;
}

/**
 * @param {string} objText
 * @param {(name: string) => Uint8Array | undefined} readSibling  reads .mtl/texture files next to the .obj
 */
export function objToDocument(objText, readSibling, name = 'obj') {
  const v = [], vt = [], vn = [];
  const groups = new Map(); // material -> { pos, uv, nrm }
  let mtl = new Map();
  let group;
  const use = (m) => {
    if (!groups.has(m)) groups.set(m, { pos: [], uv: [], nrm: [] });
    group = groups.get(m);
  };
  use('');
  for (const line of objText.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    switch (t[0]) {
      case 'v': v.push(t.slice(1, 4).map(Number)); break;
      case 'vt': vt.push(t.slice(1, 3).map(Number)); break;
      case 'vn': vn.push(t.slice(1, 4).map(Number)); break;
      case 'mtllib': {
        const data = readSibling(t.slice(1).join(' '));
        if (data) mtl = parseMtl(new TextDecoder().decode(data));
        break;
      }
      case 'usemtl': use(t.slice(1).join(' ')); break;
      case 'f': {
        const idx = (s, arr) => {
          const i = parseInt(s, 10);
          return i < 0 ? arr.length + i : i - 1;
        };
        const verts = t.slice(1).map((s) => s.split('/'));
        for (let i = 1; i + 1 < verts.length; i++) {
          const tri = [verts[0], verts[i], verts[i + 1]];
          // Flat normal for faces without vn.
          let fn;
          if (!tri.every((x) => x[2])) {
            const [a, b, c] = tri.map((x) => v[idx(x[0], v)]);
            const u = b.map((q, k) => q - a[k]), w = c.map((q, k) => q - a[k]);
            const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            const l = Math.hypot(...n) || 1;
            fn = n.map((q) => q / l);
          }
          for (const x of tri) {
            group.pos.push(...v[idx(x[0], v)]);
            const uv = x[1] ? vt[idx(x[1], vt)] : [0, 0];
            group.uv.push(uv[0], 1 - uv[1]);
            group.nrm.push(...(x[2] ? vn[idx(x[2], vn)] : fn));
          }
        }
        break;
      }
    }
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(name);
  const textures = new Map();
  for (const [mname, g] of groups) {
    if (!g.pos.length) continue;
    const m = mtl.get(mname) ?? { kd: [0.8, 0.8, 0.8], d: 1 };
    const mat = doc.createMaterial(mname || 'default').setBaseColorFactor([...m.kd, m.d]).setRoughnessFactor(0.85).setMetallicFactor(0);
    if (m.d < 1) mat.setAlphaMode('BLEND');
    if (m.map) {
      if (!textures.has(m.map)) {
        const img = readSibling(m.map);
        textures.set(m.map, img && doc.createTexture(m.map).setImage(img).setMimeType(m.map.endsWith('.png') ? 'image/png' : 'image/jpeg'));
      }
      const tex = textures.get(m.map);
      if (tex) mat.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, m.d]);
    }
    const acc = (arr, type) => doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(arr));
    mesh.addPrimitive(
      doc.createPrimitive()
        .setMaterial(mat)
        .setAttribute('POSITION', acc(g.pos, 'VEC3'))
        .setAttribute('NORMAL', acc(g.nrm, 'VEC3'))
        .setAttribute('TEXCOORD_0', acc(g.uv, 'VEC2')),
    );
  }
  doc.createScene(name).addChild(doc.createNode(name).setMesh(mesh));
  return doc;
}
