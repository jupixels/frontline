export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  level: QualityLevel;
  /** Max device pixel ratio. */
  pixelRatio: number;
  shadowMapSize: number;
  /** N8AO ambient occlusion: off, half-res performance, or full-res. */
  ao: 'off' | 'half' | 'full';
  bloom: boolean;
  smaa: boolean;
  /** Tilt-shift depth of field when zoomed in. */
  tiltShift: boolean;
  /** Camera distance under which infantry use the full animated rig instead of instanced poses. */
  infantryLodDistance: number;
  /** Cap on simultaneously animated infantry rigs. */
  maxInfantryRigs: number;
  /** Particle spawn multiplier. */
  particles: number;
  /** Pooled point lights for explosions. */
  flashLights: number;
  decalResolution: number;
  dustTrails: boolean;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low', pixelRatio: 1, shadowMapSize: 1024, ao: 'off', bloom: false, smaa: false, tiltShift: false,
    infantryLodDistance: 60, maxInfantryRigs: 24, particles: 0.4, flashLights: 0, decalResolution: 1024, dustTrails: false,
  },
  medium: {
    level: 'medium', pixelRatio: 1, shadowMapSize: 2048, ao: 'half', bloom: true, smaa: true, tiltShift: false,
    infantryLodDistance: 110, maxInfantryRigs: 60, particles: 0.7, flashLights: 2, decalResolution: 2048, dustTrails: true,
  },
  high: {
    level: 'high', pixelRatio: 1.5, shadowMapSize: 2048, ao: 'full', bloom: true, smaa: true, tiltShift: false,
    infantryLodDistance: 150, maxInfantryRigs: 120, particles: 1, flashLights: 4, decalResolution: 2048, dustTrails: true,
  },
  ultra: {
    level: 'ultra', pixelRatio: 2, shadowMapSize: 4096, ao: 'full', bloom: true, smaa: true, tiltShift: true,
    infantryLodDistance: 220, maxInfantryRigs: 250, particles: 1.3, flashLights: 4, decalResolution: 2048, dustTrails: true,
  },
};

/** Initial level: `?quality=low|medium|high|ultra` in the URL, else a remembered choice, else high. */
export function initialQuality(): QualityLevel {
  const fromUrl = new URLSearchParams(location.search).get('quality');
  if (fromUrl && (QUALITY_LEVELS as string[]).includes(fromUrl)) return fromUrl as QualityLevel;
  try {
    const saved = localStorage.getItem('frontline.quality');
    if (saved && (QUALITY_LEVELS as string[]).includes(saved)) return saved as QualityLevel;
  } catch {
    // storage blocked; fall through
  }
  return 'high';
}
