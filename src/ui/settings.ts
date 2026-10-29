import { ACTIONS, defaultKeybinds, rebind, type ActionId, type Keybinds } from './keybinds';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface VolumeSettings {
  /** 0..1 each. */
  master: number;
  music: number;
  sfx: number;
  voice: number;
}

export interface Settings {
  playerName: string;
  graphics: QualityPreset;
  volume: VolumeSettings;
  /** Multiplier for screen-edge and arrow-key panning. 0 turns edge-pan off. */
  edgePanSpeed: number;
  showFps: boolean;
  /** 0.85..1.25, scales the HUD. */
  uiScale: number;
  keybinds: Keybinds;
}

export const QUALITY_PRESETS: { id: QualityPreset; label: string; detail: string }[] = [
  { id: 'low', label: 'Low', detail: 'No shadows or post effects. For integrated graphics.' },
  { id: 'medium', label: 'Medium', detail: 'Basic shadows, FXAA, no ambient occlusion.' },
  { id: 'high', label: 'High', detail: 'Soft shadows, AO, bloom. Recommended.' },
  { id: 'ultra', label: 'Ultra', detail: 'Full post stack, high-res shadows, max particles.' },
];

const CALLSIGNS = ['Viper', 'Falcon', 'Ghost', 'Ranger', 'Nomad', 'Raven', 'Saber', 'Atlas', 'Bishop', 'Kestrel'];

export function defaultSettings(): Settings {
  return {
    playerName: `${CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)]}-${10 + Math.floor(Math.random() * 90)}`,
    graphics: 'high',
    volume: { master: 0.8, music: 0.5, sfx: 0.8, voice: 0.8 },
    edgePanSpeed: 1,
    showFps: false,
    uiScale: 1,
    keybinds: defaultKeybinds(),
  };
}

/** The subset of the Web Storage API we use, so tests can pass a Map-backed fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'frontline.settings.v1';

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Merge whatever was stored over the defaults, dropping anything malformed. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Settings>;
  const vol = (r.volume ?? {}) as Partial<VolumeSettings>;
  const keys = defaultKeybinds();
  if (r.keybinds && typeof r.keybinds === 'object') {
    for (const a of ACTIONS) {
      const v = (r.keybinds as Record<string, unknown>)[a.id];
      if (typeof v === 'string' && v) keys[a.id] = v;
    }
  }
  return {
    playerName: typeof r.playerName === 'string' && r.playerName.trim() ? r.playerName.trim().slice(0, 20) : d.playerName,
    graphics: QUALITY_PRESETS.some((q) => q.id === r.graphics) ? (r.graphics as QualityPreset) : d.graphics,
    volume: {
      master: clamp(vol.master, 0, 1, d.volume.master),
      music: clamp(vol.music, 0, 1, d.volume.music),
      sfx: clamp(vol.sfx, 0, 1, d.volume.sfx),
      voice: clamp(vol.voice, 0, 1, d.volume.voice),
    },
    edgePanSpeed: clamp(r.edgePanSpeed, 0, 2.5, d.edgePanSpeed),
    showFps: typeof r.showFps === 'boolean' ? r.showFps : d.showFps,
    uiScale: clamp(r.uiScale, 0.85, 1.25, d.uiScale),
    keybinds: keys,
  };
}

function browserStorage(): KeyValueStore | null {
  try {
    const s = globalThis.localStorage;
    // Touch it: Safari private mode and blocked site data throw here.
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return null;
  }
}

/** Persistent settings (localStorage). Every change is saved and broadcast to subscribers. */
export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();
  private readonly storage: KeyValueStore | null;

  constructor(storage: KeyValueStore | null = browserStorage()) {
    this.storage = storage;
    let raw: unknown = null;
    try {
      const text = storage?.getItem(STORAGE_KEY);
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }
    this.value = sanitizeSettings(raw);
    // Persist the generated callsign so it stays stable between visits.
    if (!raw) this.save();
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Omit<Settings, 'volume'>> & { volume?: Partial<VolumeSettings> }): void {
    this.value = sanitizeSettings({ ...this.value, ...patch, volume: { ...this.value.volume, ...patch.volume } });
    this.save();
    this.emit();
  }

  setKey(action: ActionId, code: string): void {
    this.update({ keybinds: rebind(this.value.keybinds, action, code) });
  }

  resetKeys(): void {
    this.update({ keybinds: defaultKeybinds() });
  }

  subscribe(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.value);
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked: settings still work for this session.
    }
  }
}
