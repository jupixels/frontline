// Deterministic noise lives in src/shared/terrain.ts (the sim samples the same terrain). This file
// re-exports it for render code and adds render-only randomness.

export { fbm, hash2, lerp, ridged, smoothstep, valueNoise } from '../shared/terrain';

/** Cheap render-only random in [0, 1). Not for sim. */
export const rand = Math.random;

export function randRange(a: number, b: number): number {
  return a + (b - a) * Math.random();
}
