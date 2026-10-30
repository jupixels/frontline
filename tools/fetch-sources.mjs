// Downloads the free (CC0) asset sources listed under `sources` in tools/assets.manifest.json
// into a cache folder outside the repo. build-assets.mjs calls this before it builds anything,
// so `npm run assets` is the only command you need.
//
//   node tools/fetch-sources.mjs [--cache <dir>] [--update-hashes]
//
// Each file is checked against the sha256 in the manifest. A mismatch stops the build: the
// upstream file changed, so look at it and then rerun with --update-hashes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export function defaultCacheDir() {
  return process.env.FRONTLINE_ASSET_CACHE ?? join(homedir(), 'Downloads', 'frontline-sources');
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

// Kenney hands out short-lived signed links, so ask for a fresh one each time.
async function kenneyUrl(slug) {
  const page = `https://kenney.nl/assets/${slug}`;
  const cookie = (await get(page)).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const id = Buffer.from(`assets/${slug}`).toString('hex');
  const { url } = await (await get(`https://kenney.nl/download-link/${id}`, { headers: { Referer: page, Cookie: cookie } })).json();
  if (!url) throw new Error(`Kenney returned no download link for ${slug}`);
  return url;
}

/** Ensures every source file is in the cache. Returns (and saves) the updated manifest if hashes changed. */
export async function fetchSources(manifestPath, cacheDir, { updateHashes = false } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mkdirSync(cacheDir, { recursive: true });
  let changed = false;
  for (const s of manifest.sources ?? []) {
    const p = join(cacheDir, s.file);
    let data;
    if (existsSync(p)) {
      data = readFileSync(p);
    } else {
      const url = s.kenney ? await kenneyUrl(s.kenney) : s.url;
      console.log(`download ${s.file}`);
      data = Buffer.from(await (await get(url)).arrayBuffer());
      writeFileSync(p, data);
    }
    const h = sha256(data);
    if (s.sha256 !== h) {
      if (s.sha256 && !updateHashes) {
        throw new Error(`${s.file}: sha256 ${h} doesn't match the manifest. Check the file, then rerun with --update-hashes.`);
      }
      s.sha256 = h;
      changed = true;
    }
  }
  if (changed) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (import.meta.url.endsWith(process.argv[1]?.replaceAll('\\', '/').split('/').pop() ?? '')) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--cache');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  await fetchSources(join(root, 'tools', 'assets.manifest.json'), i >= 0 ? args[i + 1] : defaultCacheDir(), {
    updateHashes: args.includes('--update-hashes'),
  });
  console.log('sources ok');
}
