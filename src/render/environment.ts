import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { assetUrl } from '../shared/view';
import { assetExists } from './terrainTextures';

/** Per-map light and weather. Picked by `MapDef.atmosphere`. */
export interface Atmosphere {
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  sunColor: THREE.ColorRepresentation;
  sunIntensity: number;
  turbidity: number;
  rayleigh: number;
  fogColor: THREE.ColorRepresentation;
  fogDensity: number;
  hemiSky: THREE.ColorRepresentation;
  hemiGround: THREE.ColorRepresentation;
  hemiIntensity?: number;
  envIntensity: number;
  /** Light the scene with the shipped HDRI (it's a sunny sky, so only clear presets use it). */
  hdri?: boolean;
  /** Water tint (shallow, deep). */
  water?: [THREE.ColorRepresentation, THREE.ColorRepresentation];
  /** Ground under this weather: bleached grass and rain-wet soil. */
  ground: { dry: number; wet: number };
  /** Cloud shadows drifting over the land: cover 0..1, darkness 0..1, size in meters. */
  clouds: { cover: number; darkness: number; scale: number };
  /** Wind heading (radians, 0 = +z) and strength 0..1: clouds, grass sway, rain slant, waves. */
  wind: { heading: number; strength: number };
  /** Rain intensity 0..1. */
  rain: number;
  /** Heat shimmer 0..1 (post distortion near the ground). */
  shimmer: number;
  /** Wave height/choppiness multiplier for water (1 = moderate). */
  waves: number;
  /** Color grade: warmth (-1 cool .. 1 warm), saturation multiplier, contrast 0..1. */
  grade: { warmth: number; saturation: number; contrast: number };
}

/** Valley Pass: late-afternoon golden light, long shadows, scattered fair-weather clouds. */
export const GOLDEN_HOUR: Atmosphere = {
  sunElevationDeg: 28,
  sunAzimuthDeg: 215,
  sunColor: 0xffd9a8,
  sunIntensity: 3.2,
  turbidity: 7,
  rayleigh: 1.6,
  fogColor: 0xc9c2b0,
  fogDensity: 0.0009,
  hemiSky: 0xcfdcf0,
  hemiGround: 0x5a5236,
  envIntensity: 1,
  hdri: true,
  ground: { dry: 0.55, wet: 0 },
  clouds: { cover: 0.42, darkness: 0.32, scale: 260 },
  wind: { heading: 0.9, strength: 0.35 },
  rain: 0,
  shimmer: 0,
  waves: 0.7,
  grade: { warmth: 0.6, saturation: 1.02, contrast: 0.36 },
};

/** Coastal Strait: low grey overcast, drifting rain, wet dark ground, choppy grey-green sea. */
export const RAIN: Atmosphere = {
  sunElevationDeg: 48,
  sunAzimuthDeg: 160,
  // A brighter diffuse sun than real overcast so shapes keep their shading; thin haze so the
  // islands and units stay crisp at RTS zoom. The rain and wet ground carry the mood.
  sunColor: 0xdde4ec,
  sunIntensity: 2.1,
  turbidity: 14,
  rayleigh: 3.0,
  fogColor: 0x7d878e,
  fogDensity: 0.0008,
  hemiSky: 0xb2bdc8,
  hemiGround: 0x464b46,
  hemiIntensity: 0.45,
  envIntensity: 1.2,
  water: [0x3f6b6a, 0x13282d],
  ground: { dry: 0.05, wet: 0.6 },
  clouds: { cover: 0.65, darkness: 0.2, scale: 220 },
  wind: { heading: -0.6, strength: 0.65 },
  rain: 0.8,
  shimmer: 0,
  waves: 1.25,
  grade: { warmth: -0.3, saturation: 1.08, contrast: 0.44 },
};

/** Plain overcast (no rain), for maps that ask for it by name. */
export const OVERCAST: Atmosphere = { ...RAIN, rain: 0, ground: { dry: 0.15, wet: 0.2 }, waves: 1 };

/** Desert Oilfields: hot noon, short hard shadows, pale dust haze and heat shimmer. */
export const HAZE: Atmosphere = {
  sunElevationDeg: 66,
  sunAzimuthDeg: 190,
  sunColor: 0xfff0d2,
  sunIntensity: 3.5,
  turbidity: 11,
  rayleigh: 1.0,
  fogColor: 0xd7c39d,
  fogDensity: 0.0012,
  hemiSky: 0xd6e2f0,
  hemiGround: 0x8a7350,
  envIntensity: 1.05,
  water: [0x4f9a8c, 0x1b4a4e],
  ground: { dry: 1, wet: 0 },
  clouds: { cover: 0.18, darkness: 0.25, scale: 320 },
  wind: { heading: 2.2, strength: 0.4 },
  rain: 0,
  shimmer: 0.8,
  waves: 0.6,
  grade: { warmth: 0.75, saturation: 0.95, contrast: 0.32 },
};
export const NOON = HAZE;

/** Inland Sea: windy, steel-grey sky with fast broken clouds, whitecaps on a dark sea. */
export const WINDY: Atmosphere = {
  sunElevationDeg: 38,
  sunAzimuthDeg: 300,
  sunColor: 0xe6ebf2,
  sunIntensity: 2.4,
  turbidity: 12,
  rayleigh: 2.8,
  fogColor: 0x97a3ad,
  fogDensity: 0.0011,
  hemiSky: 0xb9c6d4,
  hemiGround: 0x4a4f4a,
  hemiIntensity: 0.45,
  envIntensity: 1.25,
  water: [0x3e6f78, 0x0f2530],
  ground: { dry: 0.25, wet: 0.15 },
  clouds: { cover: 0.55, darkness: 0.36, scale: 300 },
  wind: { heading: 2.6, strength: 1 },
  rain: 0,
  shimmer: 0,
  waves: 1.6,
  grade: { warmth: -0.3, saturation: 0.9, contrast: 0.38 },
};

/** Iron Gulf: industrial dusk, low orange sun, smoky violet haze. Kept bright enough for teams to read. */
export const DUSK: Atmosphere = {
  sunElevationDeg: 13,
  sunAzimuthDeg: 250,
  sunColor: 0xffae70,
  sunIntensity: 3.0,
  turbidity: 10,
  rayleigh: 2.4,
  fogColor: 0x9a8f98,
  fogDensity: 0.0012,
  hemiSky: 0xa9b8d8,
  hemiGround: 0x4a3c30,
  hemiIntensity: 0.65,
  envIntensity: 1.15,
  water: [0x3c6a70, 0x14262f],
  ground: { dry: 0.4, wet: 0.1 },
  clouds: { cover: 0.35, darkness: 0.28, scale: 280 },
  wind: { heading: 1.6, strength: 0.45 },
  rain: 0,
  shimmer: 0,
  waves: 0.9,
  grade: { warmth: 0.5, saturation: 1.0, contrast: 0.4 },
};

/** Sandbox: crisp clear morning, neutral grade (a reference look for testing). */
export const CLEAR: Atmosphere = {
  ...GOLDEN_HOUR,
  sunElevationDeg: 42,
  sunAzimuthDeg: 140,
  sunColor: 0xfff4e4,
  sunIntensity: 3.0,
  turbidity: 5,
  fogColor: 0xbfcad3,
  fogDensity: 0.0008,
  ground: { dry: 0.3, wet: 0 },
  clouds: { cover: 0.3, darkness: 0.25, scale: 240 },
  wind: { heading: 0.4, strength: 0.25 },
  grade: { warmth: 0.1, saturation: 1.05, contrast: 0.32 },
};

/** Atmosphere preset by MapDef.atmosphere name (older names map onto the nearest preset). */
export function atmosphereFor(name: string | undefined): Atmosphere {
  switch (name) {
    case 'rain':
      return RAIN;
    case 'overcast':
      return OVERCAST;
    case 'haze':
    case 'noon':
      return HAZE;
    case 'windy':
      return WINDY;
    case 'dusk':
      return DUSK;
    case 'clear':
      return CLEAR;
    default:
      return GOLDEN_HOUR;
  }
}

/**
 * Sky, sun with camera-fitted shadows, IBL and distance fog.
 * The shadow frustum follows the camera's ground footprint and snaps to shadow texels so it doesn't shimmer.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly sunDir: THREE.Vector3;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;
  private shadowExtent = 0;
  private readonly lightSpace = new THREE.Matrix4();
  private readonly lightToWorld = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    readonly atmosphere: Atmosphere = GOLDEN_HOUR,
  ) {
    const a = atmosphere;
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - a.sunElevationDeg),
      THREE.MathUtils.degToRad(a.sunAzimuthDeg),
    );

    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = a.turbidity;
    u.rayleigh.value = a.rayleigh;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(this.sunDir);
    scene.add(this.sky);

    // Image-based lighting until (or unless) an HDRI is available. The Sky shader's sun disc is far
    // too hot for IBL (it turns every glossy surface white), so the env is a soft gradient dome instead.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(buildEnvDome(this.sunDir, new THREE.Color(a.hemiSky), new THREE.Color(a.fogColor), new THREE.Color(a.hemiGround), new THREE.Color(a.sunColor)));
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    scene.environmentIntensity = a.envIntensity;
    pmrem.dispose();

    scene.fog = new THREE.FogExp2(a.fogColor, a.fogDensity);

    this.sun = new THREE.DirectionalLight(a.sunColor, a.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 3;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(a.hemiSky, a.hemiGround, a.hemiIntensity ?? 0.35);
    scene.add(this.hemi);

    this.lightToWorld.lookAt(new THREE.Vector3(), this.sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    this.lightSpace.copy(this.lightToWorld).invert();
  }

  /** Use `textures/sky/sky.hdr` for IBL when the asset session has shipped it. The visible sky stays procedural so the sun matches. */
  async loadHdri(): Promise<void> {
    if (!this.atmosphere.hdri) return;
    const path = 'textures/sky/sky.hdr';
    if (!(await assetExists(path))) return;
    try {
      const hdr = await new HDRLoader().loadAsync(assetUrl(path));
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const old = this.scene.environment;
      this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
      old?.dispose();
      hdr.dispose();
      pmrem.dispose();
    } catch (err) {
      console.warn('HDRI load failed, keeping procedural sky IBL', err);
    }
  }

  setShadowMapSize(size: number): void {
    const s = this.sun.shadow;
    if (s.mapSize.x === size) return;
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
  }

  /** Fit the sun's shadow frustum around what the camera can see. */
  updateShadows(target: THREE.Vector3, viewDistance: number): void {
    const extent = THREE.MathUtils.clamp(viewDistance * 1.25, 50, 420);
    const cam = this.sun.shadow.camera;
    if (Math.abs(extent - this.shadowExtent) > 1) {
      this.shadowExtent = extent;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.near = 1;
      cam.far = 900;
      cam.updateProjectionMatrix();
    }
    // Snap the center to whole shadow texels in light space.
    const texel = (extent * 2) / this.sun.shadow.mapSize.x;
    const c = this.tmp.copy(target).applyMatrix4(this.lightSpace);
    c.x = Math.round(c.x / texel) * texel;
    c.y = Math.round(c.y / texel) * texel;
    c.applyMatrix4(this.lightToWorld);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, 400);
    this.sun.target.updateMatrixWorld();
  }
}

/** Sky-gradient dome with a soft sun glow, rendered once into a PMREM for image-based lighting. */
function buildEnvDome(sunDir: THREE.Vector3, zenith: THREE.Color, horizon: THREE.Color, ground: THREE.Color, sun: THREE.Color): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSun: { value: sunDir.clone().normalize() },
      uZenith: { value: zenith.clone().multiplyScalar(0.9) },
      uHorizon: { value: horizon.clone().multiplyScalar(1.1) },
      uGround: { value: ground.clone().multiplyScalar(0.5) },
      uSunColor: { value: sun.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun, uZenith, uHorizon, uGround, uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = d.y > 0.0 ? mix(uHorizon, uZenith, pow(d.y, 0.6)) : mix(uHorizon, uGround, pow(-d.y, 0.4));
        float s = max(dot(d, uSun), 0.0);
        c += uSunColor * (pow(s, 12.0) * 1.5 + pow(s, 3.0) * 0.25);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), mat);
}
