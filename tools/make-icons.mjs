// Renders the app icons in public/icons/ from one SVG. Run: node tools/make-icons.mjs
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

// Green objective diamond on the menu's dark panel colour. `pad` shrinks the mark for maskable icons,
// whose outer 20% may be cropped by the OS.
const svg = (pad, rounded) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 96 : 0}" fill="#111617"/>
  <g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
    <path d="M256 56 L456 256 L256 456 L56 256 Z" fill="none" stroke="#9dff7a" stroke-width="28" stroke-linejoin="round"/>
    <path d="M256 150 L362 256 L256 362 L150 256 Z" fill="#9dff7a"/>
    <path d="M208 284 L256 236 L304 284" fill="none" stroke="#111617" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const render = (file, size, pad, rounded) => sharp(Buffer.from(svg(pad, rounded))).resize(size, size).png().toFile(join(out, file));

await Promise.all([
  render('icon-192.png', 192, 0.08, true),
  render('icon-512.png', 512, 0.08, true),
  render('maskable-512.png', 512, 0.3, false),
  render('apple-touch-icon.png', 180, 0.12, false),
]);
console.log('icons written to', out);
