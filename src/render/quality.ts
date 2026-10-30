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
  /** Same for vehicles (full model with turret aim and animation vs instanced rest pose). */
  vehicleLodDistance: number;
  maxVehicleRigs: number;
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
    infantryLodDistance: 40, maxInfantryRigs: 8, vehicleLodDistance: 60, maxVehicleRigs: 8, particles: 0.4, flashLights: 0, decalResolution: 1024, dustTrails: false,
  },
  medium: {
    level: 'medium', pixelRatio: 1, shadowMapSize: 2048, ao: 'half', bloom: true, smaa: true, tiltShift: false,
    infantryLodDistance: 60, maxInfantryRigs: 20, vehicleLodDistance: 100, maxVehicleRigs: 20, particles: 0.7, flashLights: 2, decalResolution: 2048, dustTrails: true,
  },
  high: {
    level: 'high', pixelRatio: 1, shadowMapSize: 2048, ao: 'full', bloom: true, smaa: true, tiltShift: false,
    infantryLodDistance: 80, maxInfantryRigs: 30, vehicleLodDistance: 130, maxVehicleRigs: 30, particles: 1, flashLights: 4, decalResolution: 2048, dustTrails: true,
  },
  ultra: {
    level: 'ultra', pixelRatio: 1.5, shadowMapSize: 4096, ao: 'full', bloom: true, smaa: true, tiltShift: true,
    infantryLodDistance: 140, maxInfantryRigs: 80, vehicleLodDistance: 200, maxVehicleRigs: 60, particles: 1.3, flashLights: 4, decalResolution: 2048, dustTrails: true,
  },
};

/**
 * Initial level: `?quality=low|medium|high|ultra` in the URL, else a remembered choice, else a guess
 * from the GPU name (integrated/mobile GPUs start at medium).
 */
export function initialQuality(gpu = ''): QualityLevel {
  const fromUrl = new URLSearchParams(location.search).get('quality');
  if (fromUrl && (QUALITY_LEVELS as string[]).includes(fromUrl)) return fromUrl as QualityLevel;
  try {
    const saved = localStorage.getItem('frontline.quality');
    if (saved && (QUALITY_LEVELS as string[]).includes(saved)) return saved as QualityLevel;
  } catch {
    // storage blocked; fall through
  }
  return /intel|mali|adreno|powervr|apple|swiftshader|llvmpipe|microsoft basic/i.test(gpu) ? 'medium' : 'high';
}

export function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
}
