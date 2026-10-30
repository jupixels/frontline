// Small deterministic noise helpers. Only + - * / floor and integer ops, so the terrain height
// function built on them gives the same answer on every peer and can move to shared/ for the sim.

/** Integer lattice hash → [0, 1). */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function wrap(i: number, period: number): number {
  return period > 0 ? ((i % period) + period) % period : i;
}

/** Smooth value noise in [0, 1). With `period` > 0 it tiles every `period` lattice cells. */
export function valueNoise(x: number, y: number, seed: number, period = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = wrap(ix, period);
  const x1 = wrap(ix + 1, period);
  const y0 = wrap(iy, period);
  const y1 = wrap(iy + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal sum of value noise in [0, 1). Tiling period doubles with each octave. */
export function fbm(x: number, y: number, seed: number, octaves: number, period = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, seed + o * 31, period * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1): sharp crests, good for rock cracks and mountain ridges. */
export function ridged(x: number, y: number, seed: number, octaves: number, period = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, seed + o * 17, period * f) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cheap render-only random in [0, 1). Not for sim. */
export const rand = Math.random;

export function randRange(a: number, b: number): number {
  return a + (b - a) * Math.random();
}
