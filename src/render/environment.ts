import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { assetUrl } from '../shared/view';
import { assetExists } from './terrainTextures';

/** Time-of-day look. Maps will pick one of these once MapDef carries it. */
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
  envIntensity: number;
}

/** Late-afternoon "golden hour lite": warm low sun, long shadows, hazy distance. */
export const GOLDEN_HOUR: Atmosphere = {
  sunElevationDeg: 30,
  sunAzimuthDeg: 215,
  sunColor: 0xffe2bd,
  sunIntensity: 3.1,
  turbidity: 7,
  rayleigh: 1.6,
  fogColor: 0xc3c4bd,
  fogDensity: 0.0016,
  hemiSky: 0xcfdcf0,
  hemiGround: 0x5a5236,
  envIntensity: 1,
};

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

    this.hemi = new THREE.HemisphereLight(a.hemiSky, a.hemiGround, 0.35);
    scene.add(this.hemi);

    this.lightToWorld.lookAt(new THREE.Vector3(), this.sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    this.lightSpace.copy(this.lightToWorld).invert();
  }

  /** Use `textures/sky/sky.hdr` for IBL when the asset session has shipped it. The visible sky stays procedural so the sun matches. */
  async loadHdri(): Promise<void> {
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
