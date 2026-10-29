// Builds optimized game assets from the raw asset zips.
//
//   npm run assets -- [--src <dir with the zips>] [--only <substring>]
//
// Reads tools/assets.manifest.json, pulls each listed file out of its zip, and for models:
// normalizes scale to meters, drops unlisted clips, compresses textures to WebP and geometry
// with meshopt. Output goes to public/assets/ and is committed (Pages can't serve LFS).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
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

// Sounds: copied as-is, or re-encoded with ffmpeg when the entry has `encode` (see tools/README.md).
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
// Input goes through a temp file: ffmpeg stops reading early when trimming, which breaks stdin pipes.
const tmpIn = join(tmpdir(), `frontline-sound-${process.pid}.mp3`);
process.on('exit', () => rmSync(tmpIn, { force: true }));
function runFfmpeg(args, input) {
  writeFileSync(tmpIn, input);
  args = args.map((a) => (a === 'pipe:0' ? tmpIn : a));
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', ...args], { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`Can't run ffmpeg (${r.error.message}). Install it or set FFMPEG=<path>; sound entries with "encode" need it.`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(-500)}`);
  return r;
}

// Non-silent [start, end) regions, for recordings that hold several shots separated by silence.
function soundRegions(data) {
  const log = runFfmpeg(['-i', 'pipe:0', '-af', 'silencedetect=n=-40dB:d=0.25', '-f', 'null', '-'], data).stderr.toString();
  const marks = [...log.matchAll(/silence_(start|end): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]);
  const regions = [];
  let start = 0;
  for (const [kind, t] of marks) {
    if (kind === 'start') {
      if (t - start > 0.15) regions.push([start, t]);
      start = Infinity;
    } else start = t;
  }
  const dur = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const end = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : Infinity;
  if (end - start > 0.15) regions.push([start, Infinity]);
  return regions;
}

function encodeSound(data, e, start = 0, end = Infinity) {
  const from = Math.max(0, start - 0.02);
  // Silence detection cuts reverb tails short, so keep a bit past the detected end.
  let dur = Math.min(end + 0.3 - from, e.maxSeconds ?? Infinity);
  const filters = [];
  if (Number.isFinite(dur)) filters.push(`afade=t=out:st=${Math.max(0, dur - 0.12).toFixed(3)}:d=0.12`);
  const args = ['-i', 'pipe:0', '-ss', from.toFixed(3)];
  if (Number.isFinite(dur)) args.push('-t', dur.toFixed(3));
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-ac', e.stereo ? '2' : '1', '-ar', String(e.sampleRate ?? 44100), '-b:a', e.bitrate ?? '64k', '-f', 'mp3', 'pipe:1');
  return runFfmpeg(args, data).stdout;
}

const sounds = manifest.sounds.filter((s) => !only || s.out.includes(only) || s.prefix.includes(only));
for (const s of sounds) {
  const files = zipFiles(s.zip, [s.prefix]);
  let n = 0;
  let bytes = 0;
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.mp3') || name.endsWith('/')) continue;
    const rel = name.slice(s.prefix.length);
    if (s.files && !s.files.includes(rel)) continue;
    const outs = [];
    if (!s.encode) outs.push([rel, data]);
    else if (!s.encode.split) outs.push([rel, encodeSound(data, s.encode)]);
    else {
      const regions = soundRegions(data).slice(0, s.encode.split);
      const stem = rel.replace(/\.mp3$/, '');
      regions.forEach(([a, b], i) => outs.push([`${stem}_${i + 1}.mp3`, encodeSound(data, s.encode, a, b)]));
    }
    for (const [out, d] of outs) {
      write(s.out + out, d);
      bytes += d.byteLength;
      n++;
    }
  }
  console.log(`${s.out}  ${n} files  ${(bytes / 1024).toFixed(0)} KB${s.encode ? '  (encoded)' : ''}  from ${basename(s.prefix)}`);
}
