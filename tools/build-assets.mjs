// Builds optimized game assets from the raw asset zips plus the free sources fetched by
// fetch-sources.mjs.
//
//   npm run assets -- [--src <dir with the zips>] [--cache <dir for downloads>] [--generated <dir>] [--only <substring>]
//
// Reads tools/assets.manifest.json. Models (GLB/glTF/OBJ, or kitbashed from several parts) are
// normalized to meters, centered and set on y=0, recolored, stripped of unlisted clips and
// unused animation channels, then compressed (WebP textures, meshopt geometry). Terrain
// textures become 1K WebP. Writes public/assets/models/catalog.json describing every model.
// Output is committed (Pages can't serve LFS).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { homedir } from 'node:os';
import { unzipSync } from 'fflate';
import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, textureCompress, meshopt, getBounds, resample, weld, unpartition, mergeDocuments,
} from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { fetchSources, defaultCacheDir } from './fetch-sources.mjs';
import { objToDocument } from './lib/obj.mjs';
import { shapeDocument, hexColor } from './lib/shapes.mjs';
import { pruneAnimationChannels, bakeHoldPose, reparentKeepWorld } from './lib/anim.mjs';
import { encodeSound, processGenerated } from './lib/audio.mjs';

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const srcDir = arg('--src') ?? process.env.FRONTLINE_ASSET_SRC ?? join(homedir(), 'Downloads');
const cacheDir = arg('--cache') ?? defaultCacheDir();
// Models made with Meshy and post-processed by tools/blender/ (see tools/generated/).
const generatedDir = arg('--generated') ?? process.env.FRONTLINE_GENERATED_SRC ?? join(homedir(), 'Downloads', 'frontline-generated');
// Sounds made with ElevenLabs: <id>/<n>/*.mp3, voice/<id>/*.mp3 and music/<state>/*.mp3 (see tools/README.md).
const sfxDir = arg('--sfx') ?? process.env.FRONTLINE_SFX_SRC ?? join(homedir(), 'Downloads', 'frontline-sfx');
const only = arg('--only');
const outRoot = join(root, 'public', 'assets');
const manifestPath = join(root, 'tools', 'assets.manifest.json');
const manifest = await fetchSources(manifestPath, cacheDir);

// ---------------------------------------------------------------------------------------------
// Source files

const zipBytes = new Map();
const zipDirs = new Map();
/** Every file under `dir` inside `zip` (searched in --src, then the download cache). */
function zipDir(zip, dir) {
  const key = `${zip}|${dir}`;
  if (!zipDirs.has(key)) {
    if (!zipBytes.has(zip)) {
      const p = [join(srcDir, zip), join(cacheDir, zip)].find(existsSync);
      if (!p) throw new Error(`Missing ${zip}. Pass --src <dir> or set FRONTLINE_ASSET_SRC.`);
      zipBytes.set(zip, readFileSync(p));
    }
    zipDirs.set(key, unzipSync(zipBytes.get(zip), { filter: (f) => f.name.startsWith(dir) }));
  }
  return zipDirs.get(key);
}
function zipFile(zip, path) {
  const files = zipDir(zip, posix.dirname(path) + '/');
  if (!files[path]) throw new Error(`${path} not found in ${zip}`);
  return files[path];
}

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

/** Splits a GLB into a JSONDocument without resolving external URIs (binaryToJSON refuses those). */
function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const resources = {};
  let json;
  for (let off = 12; off < bytes.byteLength; ) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const chunk = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) resources['@glb.bin'] = chunk;
    off += 8 + len;
  }
  if (json.buffers?.[0] && !json.buffers[0].uri) json.buffers[0].uri = '@glb.bin';
  return { json, resources };
}

const quiet = new Logger(Logger.Verbosity.WARN);

async function loadSource(spec) {
  const doc = await loadSourceRaw(spec);
  return doc.setLogger(quiet);
}

/** A `generated` source: a GLB in the generated folder, written by a tools/blender/ script. */
function generatedFile(spec) {
  const p = join(generatedDir, spec.generated);
  if (!existsSync(p)) throw new Error(`Missing ${p}. Run the tools/blender/ script for it (see tools/generated/), or pass --generated <dir>.`);
  return readFileSync(p);
}

async function loadSourceRaw(spec) {
  if (spec.box || spec.cylinder || spec.arch) return shapeDocument(spec);
  if (spec.generated) return io.readJSON(parseGlb(generatedFile(spec)));
  const dir = posix.dirname(spec.path) + '/';
  const files = zipDir(spec.zip, dir);
  const sibling = (rel) => files[posix.normalize(dir + rel.replaceAll('\\', '/'))];
  const bytes = zipFile(spec.zip, spec.path);
  const ext = spec.path.split('.').pop().toLowerCase();
  if (ext === 'obj') {
    const doc = objToDocument(new TextDecoder().decode(bytes), sibling, posix.basename(spec.path, '.obj'));
    // `texture`: base color map for OBJs that ship without an .mtl.
    if (spec.texture) {
      const tex = doc.createTexture(spec.texture).setImage(sibling(spec.texture)).setMimeType('image/png');
      for (const mat of doc.getRoot().listMaterials()) mat.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]);
    }
    return doc;
  }
  const jsonDoc = ext === 'glb' ? parseGlb(bytes) : { json: JSON.parse(new TextDecoder().decode(bytes)), resources: {} };
  // Resolve external buffers/images (Kenney GLBs reference Textures/colormap.png).
  for (const r of [...(jsonDoc.json.buffers ?? []), ...(jsonDoc.json.images ?? [])]) {
    if (r.uri && !r.uri.startsWith('data:') && !jsonDoc.resources[r.uri]) {
      const data = sibling(decodeURIComponent(r.uri));
      if (!data) throw new Error(`${spec.path}: missing resource ${r.uri}`);
      jsonDoc.resources[r.uri] = data;
    }
  }
  return io.readJSON(jsonDoc);
}

// ---------------------------------------------------------------------------------------------
// Model transforms

function sceneOf(doc) {
  return doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
}

/**
 * Wraps the scene in a root node that scales to meters, turns the model to face +Z, centers it
 * on x/z and puts its lowest point on y = -draft. A wrapper keeps clips that animate the original
 * roots intact.
 */
function normalize(doc, m, name = 'frontline_root') {
  const scene = sceneOf(doc);
  const wrap = doc.createNode(name);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrap.addChild(child);
  }
  scene.addChild(wrap);
  const b0 = getBounds(scene);
  const size = b0.max.map((v, i) => v - b0.min[i]);
  // Skinned meshes report bind-pose bounds that ignore the armature, so they take an explicit `scale`.
  const s = m.scale ?? (m.height ? m.height / size[1] : m.length ? m.length / Math.max(size[0], size[2]) : 1);
  wrap.setScale([s, s, s]);
  if (m.rotateY) {
    const r = (m.rotateY * Math.PI) / 360;
    wrap.setRotation([0, Math.sin(r), 0, Math.cos(r)]);
  }
  if (m.center !== false) {
    const b = getBounds(scene);
    wrap.setTranslation([-(b.min[0] + b.max[0]) / 2, -b.min[1] - (m.draft ?? 0), -(b.min[2] + b.max[2]) / 2]);
  }
  return wrap;
}

/** Recolors materials: `colors` maps material name (or "*") to a hex color that multiplies any texture. */
function recolor(doc, colors) {
  if (!colors) return;
  for (const mat of doc.getRoot().listMaterials()) {
    const hex = colors[mat.getName()] ?? colors['*'];
    if (hex) mat.setBaseColorFactor([...hexColor(hex), mat.getBaseColorFactor()[3]]);
  }
}

/** Gives meshes without materials a named one: `meshMaterials` maps mesh name -> { name, color, roughness, metallic }. */
function assignMaterials(doc, meshMaterials) {
  if (!meshMaterials) return;
  for (const mesh of doc.getRoot().listMeshes()) {
    const spec = meshMaterials[mesh.getName()];
    if (!spec) continue;
    const mat = doc.createMaterial(spec.name).setBaseColorFactor([...hexColor(spec.color), 1])
      .setRoughnessFactor(spec.roughness ?? 0.8).setMetallicFactor(spec.metallic ?? 0);
    for (const prim of mesh.listPrimitives()) prim.setMaterial(mat);
  }
}

/** Desaturates (and optionally tints) every base color texture, to pull bright kits toward military tones. */
async function adjustTextures(doc, adjust) {
  if (!adjust) return;
  for (const tex of doc.getRoot().listTextures()) {
    let img = sharp(tex.getImage()).modulate({ saturation: adjust.saturation ?? 1, brightness: adjust.brightness ?? 1 });
    if (adjust.tint) img = img.tint(adjust.tint);
    tex.setImage(await img.png().toBuffer()).setMimeType('image/png');
  }
}

async function buildPartDoc(part) {
  const doc = await loadSource(part);
  // `stripMeshesUnder`: drop the meshes below a node but keep the node and its animation (to swap a turret).
  if (part.stripMeshesUnder) {
    const strip = (n) => (n.setMesh(null), n.listChildren().forEach(strip));
    strip(doc.getRoot().listNodes().find((n) => n.getName() === part.stripMeshesUnder));
  }
  recolor(doc, part.colors ?? manifest.palettes?.[part.palette]);
  await adjustTextures(doc, part.textureAdjust);
  const wrap = normalize(doc, part, part.name ?? 'part');
  const [x = 0, y = 0, z = 0] = part.at ?? [];
  const t = wrap.getTranslation();
  wrap.setTranslation([t[0] + x, t[1] + y, t[2] + z]);
  return doc;
}

/** Kitbash: merges parts (other models or primitive shapes) into one scene. */
async function kitbash(parts) {
  const doc = await buildPartDoc(parts[0]);
  const scene = sceneOf(doc);
  for (const part of parts.slice(1)) {
    const partDoc = await buildPartDoc(part);
    const map = mergeDocuments(doc, partDoc);
    const merged = map.get(sceneOf(partDoc));
    for (const child of merged.listChildren()) {
      merged.removeChild(child);
      scene.addChild(child);
    }
    merged.dispose();
    // `parent`: hang the part under a named node (e.g. a turret) so it follows that node's animation.
    if (part.parent) reparentKeepWorld(doc, part.name, part.parent);
  }
  for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();
  doc.getRoot().setDefaultScene(scene);
  return doc;
}

const NAMED_NODE = /^P_|turret|rotor|wheel|barrel|gun|cannon|radar|propeller/i;

function catalogEntry(m, doc, bytes) {
  const scene = sceneOf(doc);
  const b = getBounds(scene);
  const dims = b.max.map((v, i) => +(v - b.min[i]).toFixed(2));
  // `credit` names an entry in manifest.credits; it defaults to the source zip's name.
  const sourcesOf = (x) => (x.kitbash ? x.kitbash.flatMap(sourcesOf) : x.box || x.cylinder || x.arch ? [] : [x.credit ?? x.zip]);
  const credits = [...new Set(sourcesOf(m))].map((k) => {
    if (!manifest.credits[k]) throw new Error(`${m.out}: no credits entry for "${k}"`);
    return manifest.credits[k];
  });
  const entry = {
    id: posix.basename(m.out, '.glb'),
    path: m.out,
    kind: m.kind,
    size: dims,
    sizeKB: Math.round(bytes / 1024),
    clips: doc.getRoot().listAnimations().map((a) => a.getName()),
    nodes: doc.getRoot().listNodes().map((n) => n.getName()).filter((n) => NAMED_NODE.test(n)),
    license: [...new Set(credits.map((c) => c.license))].join(' + '),
    credits: [...new Set(credits.map((c) => c.author))],
  };
  if (m.draft) entry.draft = m.draft;
  if (m.materials) entry.materials = m.materials;
  return entry;
}

async function buildModel(m) {
  const doc = m.kitbash ? await kitbash(m.kitbash) : await loadSource(m);
  const before = m.kitbash ? 0 : m.generated ? generatedFile(m).byteLength : zipFile(m.zip, m.path).byteLength;

  if (m.holdPose) bakeHoldPose(doc, m.holdPose);
  for (const [node, parent] of Object.entries(m.reparent ?? {})) reparentKeepWorld(doc, node, parent);
  if (m.clips) {
    for (const anim of doc.getRoot().listAnimations()) {
      if (m.clips.includes(anim.getName())) continue;
      // Samplers outlive their animation and would keep their accessors from being pruned.
      for (const s of anim.listSamplers()) s.dispose();
      anim.dispose();
    }
  }
  assignMaterials(doc, m.meshMaterials);
  recolor(doc, m.colors ?? manifest.palettes?.[m.palette]);
  await adjustTextures(doc, m.textureAdjust);
  if (m.kitbash) {
    if (m.length || m.height || m.scale) normalize(doc, m);
  } else {
    normalize(doc, m);
  }
  const anim = pruneAnimationChannels(doc, m.animPrune);

  await doc.transform(
    // Generated models carry a TeamPaint copy of their textured material; keep it apart from the original.
    dedup({ keepUniqueNames: !!m.generated }),
    weld(),
    resample({ tolerance: m.animTolerance ?? 1e-4 }),
    prune(),
    unpartition(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [m.textureSize ?? 512, m.textureSize ?? 512], quality: 80 }),
  );
  const entry = catalogEntry(m, doc, 0);
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }), prune());

  const out = await io.writeBinary(doc);
  write(m.out, out);
  entry.sizeKB = Math.round(out.byteLength / 1024);
  const was = before ? `  (was ${Math.round(before / 1024)} KB)` : '';
  const dropped = anim.dropped ? `  dropped ${anim.dropped}/${anim.total} anim channels` : '';
  console.log(`${m.out}  ${entry.sizeKB} KB${was}  size ${entry.size.join(' x ')} m  clips: ${entry.clips.join(', ') || '-'}${dropped}`);
  return entry;
}

function write(out, data) {
  const p = join(outRoot, out);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Build

const match = (out, ...more) => !only || [out, ...more].some((s) => s?.includes(only));

const catalogPath = join(outRoot, 'models', 'catalog.json');
const catalog = new Map(
  only && existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')).models.map((e) => [e.id, e]) : [],
);
for (const m of manifest.models.filter((m) => match(m.out, m.path, m.generated))) {
  const e = await buildModel(m);
  catalog.set(e.id, e);
}
if (catalog.size) {
  const models = [...catalog.values()].sort((a, b) => a.path.localeCompare(b.path));
  write('models/catalog.json', JSON.stringify({ $comment: 'Generated by tools/build-assets.mjs. size = [x, y, z] meters; vehicles face +Z and sit on y=0 (ships: waterline at y=0, keel at -draft).', models }, null, 2) + '\n');
}

// Terrain texture sets: albedo/normal/rough, 1K WebP.
for (const t of (manifest.textures ?? []).filter((t) => match(t.out))) {
  const files = zipDir(t.zip, '');
  const sizes = [];
  for (const [kind, suffix] of Object.entries(t.maps)) {
    const name = Object.keys(files).find((f) => f.endsWith(suffix));
    if (!name) throw new Error(`${t.zip}: no file ending in ${suffix}`);
    let img = sharp(files[name]).resize(t.size ?? 1024, t.size ?? 1024);
    // Remaps roughness into [roughMin, 1]: Grass004 ships a mean of ~0.26, which reads as a wet glint.
    if (kind === 'rough') img = img.greyscale().linear(1 - (t.roughMin ?? 0), 255 * (t.roughMin ?? 0));
    const data = await img.webp({ quality: t.quality?.[kind] ?? 82, effort: 6 }).toBuffer();
    write(`${t.out}_${kind}.webp`, data);
    sizes.push(`${kind} ${Math.round(data.byteLength / 1024)} KB`);
  }
  console.log(`${t.out}_*.webp  ${sizes.join(', ')}`);
}

// Files copied as-is from the download cache (the sky HDRI).
for (const f of (manifest.files ?? []).filter((f) => match(f.out))) {
  const data = readFileSync(join(cacheDir, f.file));
  write(f.out, data);
  console.log(`${f.out}  ${Math.round(data.byteLength / 1024)} KB`);
}

// Sounds: copied as-is, or re-encoded with ffmpeg when the entry has `encode`.
const sounds = manifest.sounds.filter((s) => match(s.out, s.prefix));
for (const s of sounds) {
  const files = zipDir(s.zip, s.prefix);
  let n = 0;
  let bytes = 0;
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.mp3') || name.endsWith('/')) continue;
    const rel = name.slice(s.prefix.length);
    if (s.files && !s.files.includes(rel)) continue;
    for (const [out, d] of s.encode ? encodeSound(rel, data, s.encode) : [[rel, data]]) {
      write(s.out + out, d);
      bytes += d.byteLength;
      n++;
    }
  }
  console.log(`${s.out}  ${n} files  ${Math.round(bytes / 1024)} KB${s.encode ? '  (encoded)' : ''}`);
}

// Generated sounds (ElevenLabs): trimmed, levelled and re-encoded per kind into sounds/gen/.
const gen = manifest.generatedSounds;
if (gen && existsSync(sfxDir) && match(gen.out)) {
  const nn = (i) => String(i + 1).padStart(2, '0');
  const mp3s = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort() : []);
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const jobs = [];
  rmSync(join(outRoot, gen.out), { recursive: true, force: true }); // takes can be dropped, so no stale files
  for (const id of subdirs(sfxDir).filter((d) => !gen.skip.includes(d)).sort()) {
    const kind = id.startsWith('ui_') ? 'ui' : gen.loops.includes(id) ? 'loop' : 'shot';
    const takes = subdirs(join(sfxDir, id)).sort((a, b) => Number(a) - Number(b));
    takes.forEach((t, i) => {
      const [file] = mp3s(join(sfxDir, id, t));
      if (file) jobs.push([join(sfxDir, id, t, file), `${id}_${nn(i)}.mp3`, kind]);
    });
  }
  for (const id of existsSync(join(sfxDir, 'voice')) ? subdirs(join(sfxDir, 'voice')).sort() : []) {
    mp3s(join(sfxDir, 'voice', id)).forEach((file, i) => jobs.push([join(sfxDir, 'voice', id, file), `voice/${id}_${nn(i)}.mp3`, 'voice']));
  }
  for (const state of existsSync(join(sfxDir, 'music')) ? subdirs(join(sfxDir, 'music')).sort() : []) {
    const [file] = mp3s(join(sfxDir, 'music', state));
    if (file) jobs.push([join(sfxDir, 'music', state, file), `music/${state}.mp3`, 'music']);
  }
  let bytes = 0;
  for (const [src, out, kind] of jobs) {
    const d = processGenerated(readFileSync(src), kind);
    if (!d) {
      console.warn(`  skipped near-silent take ${src}; regenerate it`);
      continue;
    }
    write(gen.out + out, d);
    bytes += d.byteLength;
  }
  console.log(`${gen.out}  ${jobs.length} files  ${Math.round(bytes / 1024)} KB  (generated)`);
}
