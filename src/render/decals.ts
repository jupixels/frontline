import * as THREE from 'three';

/** Stamp shapes the decal shader knows how to draw. */
export const enum DecalKind {
  /** Radial scorch with a darker crater core. R channel. */
  Scorch = 0,
  /** Two parallel tread strips. G channel. */
  Tracks = 1,
  /** Single tire/wheel strip pair, narrower. G channel. */
  Wheels = 2,
  /** Soft foam oval behind ships. B channel. */
  Wake = 3,
}

const MAX_STAMPS = 1024;
/** Seconds between fade passes. */
const FADE_EVERY = 0.5;

/**
 * A map-sized render target that accumulates ground decals: scorch marks/craters (R, permanent),
 * vehicle tracks (G, slow fade) and ship wakes (B, fast fade). Terrain and water sample it.
 * Stamps are drawn as instanced quads into the target, so cost is per stamp, not per frame.
 */
export class DecalMap {
  readonly target: THREE.WebGLRenderTarget;
  /** (minX, minZ, sizeX, sizeZ) in world meters. */
  readonly bounds: THREE.Vector4;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly stamps: THREE.InstancedMesh;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly fadeScene = new THREE.Scene();
  private fade!: THREE.MeshBasicMaterial;
  private count = 0;
  private fadeTimer = 0;
  private cleared = false;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(worldSize: number, resolution: number) {
    const half = worldSize / 2;
    this.bounds = new THREE.Vector4(-half, -half, worldSize, worldSize);
    this.target = new THREE.WebGLRenderTarget(resolution, resolution, {
      type: THREE.HalfFloatType, // 8-bit would stall the slow track fade at ~0.27
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    // Looking up from below with +Z as screen-up maps texture (u, v) to ((x - minX), (z - minZ)) / size
    // without a mirror, matching how terrain and water sample it. Materials are double-sided for this.
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, -10, 10);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -5, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 2), 2);
    geo.setAttribute('aParams', this.params);
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAMP_VERT,
      fragmentShader: STAMP_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.stamps = new THREE.InstancedMesh(geo, mat, MAX_STAMPS);
    this.stamps.frustumCulled = false;
    this.stamps.count = 0;
    this.scene.add(this.stamps);

    // dst *= fadeColor each pass: R (scorch) stays, G (tracks) fades slowly, B (wakes) quickly.
    const fade = new THREE.Mesh(
      new THREE.PlaneGeometry(worldSize * 2, worldSize * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 0.993, 0.72),
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      }),
    );
    this.fadeScene.add(fade);
    this.fade = fade.material as THREE.MeshBasicMaterial;
  }

  /**
   * How much of the track channel (G) survives each fade pass: closer to 1 keeps tread marks on the
   * ground longer, so the front line slowly scars over. Scorch (R) never fades; wakes (B) fade fast.
   */
  setTrackFade(keep: number): void {
    this.fade.color.g = keep;
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /**
   * Queue a stamp centered at (x, z). `length`/`width` in meters, `angle` is a heading
   * (radians, 0 = +Z). `strength` in [0, 1].
   */
  stamp(kind: DecalKind, x: number, z: number, length: number, width: number, angle: number, strength = 1): void {
    if (this.count >= MAX_STAMPS) return;
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), angle);
    this.m.compose(this.v.set(x, 0, z), this.q, this.s.set(width, 1, length));
    this.stamps.setMatrixAt(this.count, this.m);
    this.params.setXY(this.count, kind, strength);
    this.count++;
  }

  /** Draw queued stamps and periodic fades into the target. Call once per frame before rendering. */
  update(renderer: THREE.WebGLRenderer, dt: number): void {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    if (!this.cleared) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      this.cleared = true;
    }
    this.fadeTimer += dt;
    if (this.fadeTimer >= FADE_EVERY) {
      this.fadeTimer = 0;
      renderer.render(this.fadeScene, this.camera);
    }
    if (this.count > 0) {
      this.stamps.count = this.count;
      this.stamps.instanceMatrix.needsUpdate = true;
      this.params.needsUpdate = true;
      renderer.render(this.scene, this.camera);
      this.count = 0;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.target.dispose();
    this.stamps.geometry.dispose();
    (this.stamps.material as THREE.Material).dispose();
  }
}

const STAMP_VERT = /* glsl */ `
attribute vec2 aParams;
varying vec2 vUv;
varying vec2 vParams;
void main() {
  vUv = uv;
  vParams = aParams;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const STAMP_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vParams;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  int kind = int(vParams.x + 0.5);
  float s = vParams.y;
  vec2 p = vUv * 2.0 - 1.0;
  vec4 c = vec4(0.0);
  if (kind == 0) {
    float r = length(p);
    float ang = atan(p.y, p.x);
    float jag = 0.82 + 0.18 * sin(ang * 7.0 + s * 13.0) * sin(ang * 3.0 + 1.7);
    float scorch = smoothstep(1.0 * jag, 0.25 * jag, r);
    c.r = scorch * s;
  } else if (kind == 1 || kind == 2) {
    // Two strips along the long (v) axis.
    float x = abs(p.x);
    float inner = kind == 1 ? 0.45 : 0.62;
    float outer = kind == 1 ? 1.0 : 0.88;
    float strip = smoothstep(inner - 0.08, inner, x) * smoothstep(outer, outer - 0.08, x);
    // Tread cleats.
    float cleat = kind == 1 ? 0.65 + 0.35 * step(0.5, fract(vUv.y * 4.0)) : 1.0;
    float endFade = smoothstep(1.0, 0.6, abs(p.y));
    c.g = strip * cleat * endFade * s;
  } else {
    float r = length(vec2(p.x, p.y * 0.6));
    c.b = smoothstep(1.0, 0.2, r) * s * (0.7 + 0.3 * hash(floor(vUv * 16.0)));
  }
  gl_FragColor = c;
}
`;
