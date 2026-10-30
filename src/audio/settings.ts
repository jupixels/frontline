// Player audio preferences. The UI settings screen reads and writes these directly; no AudioManager
// instance needed (the menu runs before any match exists). Persisted to localStorage when available.

export type Bus = 'master' | 'music' | 'sfx' | 'voice';
export const BUSES: readonly Bus[] = ['master', 'music', 'sfx', 'voice'];

export interface AudioSettings {
  volume: Record<Bus, number>;
  muted: boolean;
}

const KEY = 'frontline.audio';
const DEFAULTS: AudioSettings = { volume: { master: 0.8, music: 0.5, sfx: 0.9, voice: 0.9 }, muted: false };

type Listener = (s: Readonly<AudioSettings>) => void;
const listeners = new Set<Listener>();
let current: AudioSettings = load();

function load(): AudioSettings {
  const s: AudioSettings = { volume: { ...DEFAULTS.volume }, muted: DEFAULTS.muted };
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return s;
    const p = JSON.parse(raw) as Partial<AudioSettings>;
    for (const b of BUSES) {
      const v = p.volume?.[b];
      if (typeof v === 'number' && v >= 0 && v <= 1) s.volume[b] = v;
    }
    if (typeof p.muted === 'boolean') s.muted = p.muted;
  } catch {
    // Private mode / blocked storage: fall back to defaults.
  }
  return s;
}

function commit(): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not persisted, still applied.
  }
  for (const l of listeners) l(current);
}

export function getAudioSettings(): Readonly<AudioSettings> {
  return current;
}

/** 0..1 */
export function setVolume(bus: Bus, v: number): void {
  current = { ...current, volume: { ...current.volume, [bus]: Math.min(1, Math.max(0, v)) } };
  commit();
}

export function getVolume(bus: Bus): number {
  return current.volume[bus];
}

export function setMuted(muted: boolean): void {
  current = { ...current, muted };
  commit();
}

export function isMuted(): boolean {
  return current.muted;
}

export function toggleMuted(): boolean {
  setMuted(!current.muted);
  return current.muted;
}

/** Called on every change (and not initially). Returns an unsubscribe function. */
export function onAudioSettingsChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
