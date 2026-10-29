// Builds optimized game assets from the raw asset zips.
//
//   npm run assets -- [--src <dir with the zips>] [--only <substring>]
//
// Reads tools/assets.manifest.json, pulls each listed file out of its zip, and for models:
// normalizes scale to meters, drops unlisted clips, compresses textures to WebP and geometry
// with meshopt. Output goes to public/assets/ and is committed (Pages can't serve LFS).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { unzipSync } from 'fflate';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, meshopt, getBounds, resample } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const srcDir = arg('--src') ?? process.env.FRONTLINE_ASSET_SRC ?? join(homedir(), 'Downloads');
const only = arg('--only');
const outRoot = join(root, 'public', 'assets');
const manifest = JSON.parse(readFileSync(join(root, 'tools', 'assets.manifest.json'), 'utf8'));

const zipCache = new Map();
function zipFiles(zip, wanted) {
  const key = `${zip}|${wanted.join(',')}`;
  if (!zipCache.has(key)) {
    const p = join(srcDir, zip);
    if (!existsSync(p)) throw new Error(`Missing ${p}. Pass --src <dir> or set FRONTLINE_ASSET_SRC.`);
    zipCache.set(key, unzipSync(readFileSync(p), { filter: (f) => wanted.some((w) => f.name.startsWith(w)) }));
  }
  return zipCache.get(key);
}

function write(out, data) {
  const p = join(outRoot, out);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const models = manifest.models.filter((m) => !only || m.out.includes(only) || m.path.includes(only));
const byZip = Map.groupBy(models, (m) => m.zip);
for (const [zip, list] of byZip) {
  const files = zipFiles(zip, list.map((m) => m.path));
  for (const m of list) {
    const bytes = files[m.path];
    if (!bytes) throw new Error(`${m.path} not found in ${zip}`);
    const doc = await io.readBinary(bytes);
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];

    if (m.clips) {
      for (const anim of doc.getRoot().listAnimations()) if (!m.clips.includes(anim.getName())) anim.dispose();
    }

    // Wrap the scene in a root node so scaling/rotation survive clips that animate the original roots.
    const b = getBounds(scene);
    const size = b.max.map((v, i) => v - b.min[i]);
    // Skinned meshes report bind-pose bounds that ignore the armature, so they take an explicit `scale`.
    const s = m.scale ?? (m.height ? m.height / size[1] : m.length / Math.max(size[0], size[2]));
    const wrap = doc.createNode('frontline_root').setScale([s, s, s]);
    if (m.rotateY) {
      const r = (m.rotateY * Math.PI) / 360;
      wrap.setRotation([0, Math.sin(r), 0, Math.cos(r)]);
    }
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      wrap.addChild(child);
    }
    scene.addChild(wrap);

    await doc.transform(
      dedup(),
      resample(),
      prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );

    const out = await io.writeBinary(doc);
    write(m.out, out);
    const nb = getBounds(scene);
    const dims = nb.max.map((v, i) => (v - nb.min[i]).toFixed(2)).join(' x ');
    const clips = doc.getRoot().listAnimations().map((a) => a.getName());
    console.log(`${m.out}  ${(out.byteLength / 1024).toFixed(0)} KB  (was ${(bytes.byteLength / 1024).toFixed(0)} KB)  size ${dims} m  clips: ${clips.join(', ') || '-'}`);
  }
}

const sounds = manifest.sounds.filter((s) => !only || s.out.includes(only));
for (const s of sounds) {
  const files = zipFiles(s.zip, [s.prefix]);
  let n = 0;
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.mp3') || name.endsWith('/')) continue;
    write(s.out + name.slice(s.prefix.length), data);
    n++;
  }
  console.log(`${s.out}  ${n} files`);
}
