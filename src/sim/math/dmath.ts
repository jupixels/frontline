// Deterministic math for the simulation.
//
// IEEE-754 + - * / and Math.sqrt are correctly rounded, so they give identical results in every
// browser. Transcendental functions (Math.sin, cos, atan2, pow, exp, ...) are NOT guaranteed to,
// so sim/ uses these polynomial versions instead. tests/determinism.test.ts enforces the ban.

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  return a - TWO_PI * Math.floor((a + PI) / TWO_PI);
}

/** sin via range reduction + Taylor series (|err| < 1e-7). */
export function dsin(x: number): number {
  x = wrapAngle(x);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - x2 / 110)))));
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

/** atan for |a| <= 1 (minimax polynomial, |err| < 1e-5). */
function atanUnit(a: number): number {
  const s = a * a;
  return a * (0.99997726 + s * (-0.33262347 + s * (0.19354346 + s * (-0.11643287 + s * (0.05265332 + s * -0.0117212)))));
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let r = ax >= ay ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}

/** Heading (see shared/types.ts) that faces from (0,0) toward (dx, dz). */
export function headingTo(dx: number, dz: number): number {
  return datan2(dx, dz);
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const diff = wrapAngle(to - from);
  if (Math.abs(diff) <= maxStep) return wrapAngle(to);
  return wrapAngle(from + (diff > 0 ? maxStep : -maxStep));
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}
