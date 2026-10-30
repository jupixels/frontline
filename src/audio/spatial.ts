// Pure positional-audio math (no Web Audio), so it can be unit tested.

export interface Listener {
  x: number;
  z: number;
  /** Camera distance to its ground target in meters (RtsCamera zoom, ~25..320). */
  zoom: number;
  /** Camera yaw in radians (RtsCamera convention: camera sits at target + (sin yaw, cos yaw) * horiz). */
  yaw: number;
}

export interface Spatial {
  /** 0..1 loudness from distance. 0 means inaudible; skip the sound. */
  gain: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** Effective distance in meters (ground distance combined with camera height). */
  dist: number;
  /** Low-pass cutoff in Hz; distant sounds lose their high end. */
  cutoff: number;
}

/** Distance (m) at which a sound plays at full volume. */
const REF = 30;

/**
 * Where a sound at (x, z) sits relative to the camera. `range` is the max audible ground distance
 * for this sound class (a rifle carries less far than artillery); it grows a little when zoomed out
 * so the battlefield doesn't go silent from high up.
 */
export function spatialize(l: Listener, x: number, z: number, range: number): Spatial {
  const dx = x - l.x;
  const dz = z - l.z;
  const ground = Math.hypot(dx, dz);
  // The ear is roughly where the camera is: up in the air by a share of the zoom distance.
  const height = l.zoom * 0.5;
  const dist = Math.hypot(ground, height);
  const reach = range * (1 + l.zoom / 400);
  if (ground > reach) return { gain: 0, pan: 0, dist, cutoff: 800 };
  // Inverse-distance rolloff, then a smooth fade to zero at the edge of `reach`.
  const inv = REF / Math.max(REF, dist);
  const edge = 1 - smoothstep(reach * 0.6, reach, ground);
  const gain = inv * edge;
  // Screen-right on the ground is (cos yaw, -sin yaw).
  const across = dx * Math.cos(l.yaw) - dz * Math.sin(l.yaw);
  const pan = clamp(across / (l.zoom * 0.8 + 20), -1, 1) * 0.85;
  // 18 kHz up close, falling to ~1.2 kHz at the edge of hearing.
  const t = clamp(dist / (reach + height), 0, 1);
  const cutoff = 18000 * Math.pow(1200 / 18000, t);
  return { gain, pan, dist, cutoff };
}

/** True when a weapon at this distance should use its "far" recording. */
export function isFar(dist: number, farFrom: number): boolean {
  return dist > farFrom;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
