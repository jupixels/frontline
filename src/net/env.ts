/**
 * Clock, timers and randomness used by net/. Injected so tests can run many virtual peers
 * on a simulated clock (see `LoopbackNetwork`). Nothing here affects the sim.
 */
export interface NetEnv {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Float in [0, 1). Used for room codes, seeds and secrets. */
  random(): number;
}

function cryptoRandom(): number {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

export const realEnv: NetEnv = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  random: cryptoRandom,
};

/** Random lowercase hex string of `bytes` bytes. */
export function randomHex(env: NetEnv, bytes: number): string {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(env.random() * 256).toString(16).padStart(2, '0');
  return s;
}

/** Random unsigned 32-bit integer. */
export function randomU32(env: NetEnv): number {
  return Math.floor(env.random() * 4294967296) >>> 0;
}

/** SHA-256 hex digest. Used for rejoin secrets (WebCrypto is in every target browser and Node 20+). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
