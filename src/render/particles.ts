import * as THREE from 'three';

/** How a particle quad is oriented. */
export const enum ParticleMode {
  /** Camera-facing sprite. */
  Billboard = 0,
  /** Lies flat on the ground (shockwave rings, ground dust). */
  Flat = 1,
  /** Stretched along its screen-space velocity (tracers, sparks). */
  Stretched = 2,
  /** Small hard-edged chunk (debris). */
  Chunk = 3,
}

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Seconds. */
  life: number;
  /** Start and end size in meters. */
  size0: number;
  size1: number;
  /** Linear RGB; may exceed 1 for additive pools so bloom picks it up. */
  r: number;
  g: number;
  b: number;
  /** Peak opacity. */
  a?: number;
  /** Meters/s² downward. */
  gravity?: number;
  /** Exponential velocity damping per second. */
  drag?: number;
  /** Radians/s for billboards; length factor (seconds of velocity) for stretched. */
  spin?: number;
  mode?: ParticleMode;
  /** Seconds before the particle appears. */
  delay?: number;
}

/**
 * A pool of GPU-animated particles in one instanced draw. The CPU only writes a particle's initial
 * state when it spawns (ring buffer); position, size, fade and orientation are computed in the
 * vertex shader from the spawn time, so thousands of particles cost almost nothing on the CPU.
 */
export class ParticlePool {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private cursor = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aTime: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly uniforms: { uTime: { value: number }; uSmoke: { value: THREE.Texture | null }; uSunDir: { value: THREE.Vector3 }; uSunColor: { value: THREE.Color }; uAmbient: { value: THREE.Color } };
  time = 0;

  constructor(capacity: number, kind: 'additive' | 'smoke', smokeTexture: THREE.Texture | null, sunDir: THREE.Vector3, sunColor: THREE.Color) {
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = attr(3);
    this.aVel = attr(3);
    this.aTime = attr(4); // start, life, size0, size1
    this.aColor = attr(4);
    this.aParams = attr(4); // gravity, drag, spin/stretch, mode
    // Start every slot long dead.
    for (let i = 0; i < capacity; i++) this.aTime.setXYZW(i, -1e6, 1, 0, 0);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aParams', this.aParams);
    geo.instanceCount = capacity;

    this.uniforms = {
      uTime: { value: 0 },
      uSmoke: { value: smokeTexture },
      uSunDir: { value: sunDir },
      uSunColor: { value: sunColor },
      uAmbient: { value: new THREE.Color(0.32, 0.34, 0.38) },
    };
    const additive = kind === 'additive';
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      defines: additive ? { ADDITIVE: 1 } : {},
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    Object.assign(mat.uniforms, this.uniforms);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  spawn(p: ParticleSpec): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.aPos.setXYZ(i, p.x, p.y, p.z);
    this.aVel.setXYZ(i, p.vx ?? 0, p.vy ?? 0, p.vz ?? 0);
    this.aTime.setXYZW(i, this.time + (p.delay ?? 0), p.life, p.size0, p.size1);
    this.aColor.setXYZW(i, p.r, p.g, p.b, p.a ?? 1);
    this.aParams.setXYZW(i, p.gravity ?? 0, p.drag ?? 0, p.spin ?? 0, p.mode ?? ParticleMode.Billboard);
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  update(time: number): void {
    this.time = time;
    this.uniforms.uTime.value = time;
    if (this.dirtyMax < 0) return;
    const start = this.dirtyMin;
    const count = this.dirtyMax - this.dirtyMin + 1;
    for (const a of [this.aPos, this.aVel, this.aTime, this.aColor, this.aParams]) {
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Soft, lumpy smoke puff (alpha in A, a fake height/normal-ish shade in RGB). */
export function createSmokeTexture(size = 128): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const blobs: [number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.22;
    blobs.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.14 + Math.random() * 0.16]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let d = 0;
      let top = 0;
      for (const [bx, by, br] of blobs) {
        const dx = u - bx;
        const dy = v - by;
        const k = Math.max(0, 1 - (dx * dx + dy * dy) / (br * br));
        d += k * k;
        top += k * k * (by - v + 0.3);
      }
      const n = Math.random() * 0.15;
      const alpha = Math.min(1, d * 0.9) * (0.85 + n);
      const shade = Math.min(1, Math.max(0, 0.55 + top * 0.9));
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = shade * 255;
      img.data[o + 3] = alpha * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const PARTICLE_VERT = /* glsl */ `
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aTime;
attribute vec4 aColor;
attribute vec4 aParams;
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying float vT;
varying float vMode;
varying float vSeed;
void main() {
  float age = uTime - aTime.x;
  float t = age / aTime.y;
  vUv = position.xy + 0.5;
  vColor = aColor;
  vT = t;
  vMode = aParams.w;
  vSeed = fract(aPos.x * 12.9898 + aPos.z * 78.233 + aTime.x);
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float drag = aParams.y;
  vec3 disp = drag > 0.0 ? aVel * (1.0 - exp(-drag * age)) / drag : aVel * age;
  vec3 p = aPos + disp;
  p.y -= 0.5 * aParams.x * age * age;
  vec3 vel = aVel * exp(-drag * age) - vec3(0.0, aParams.x * age, 0.0);
  // Ease-out growth.
  float size = mix(aTime.z, aTime.w, 1.0 - (1.0 - t) * (1.0 - t));
  int mode = int(aParams.w + 0.5);
  vec4 mvPosition;
  if (mode == 1) {
    mvPosition = viewMatrix * vec4(p + vec3(position.x, 0.0, position.y) * size, 1.0);
  } else if (mode == 2) {
    vec4 c = viewMatrix * vec4(p, 1.0);
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
    vec2 dir = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
    vec2 side = vec2(-dir.y, dir.x);
    float len = max(size, length(vel) * aParams.z);
    c.xy += side * position.x * size + dir * position.y * len;
    mvPosition = c;
  } else {
    float ang = aParams.z * age + vSeed * 6.2831;
    float cs = cos(ang);
    float sn = sin(ang);
    vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
    mvPosition = viewMatrix * vec4(p, 1.0);
    mvPosition.xy += q * size;
  }
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const PARTICLE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uSmoke;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
varying vec2 vUv;
varying vec4 vColor;
varying float vT;
varying float vMode;
varying float vSeed;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  int mode = int(vMode + 0.5);
  float alpha;
  vec3 col = vColor.rgb;
#ifdef ADDITIVE
  if (mode == 1) {
    // Expanding shockwave ring.
    alpha = smoothstep(1.0, 0.86, r) * smoothstep(0.55, 0.85, r);
  } else if (mode == 2) {
    alpha = (1.0 - abs(p.x)) * smoothstep(1.0, 0.3, abs(p.y));
  } else {
    alpha = pow(max(1.0 - r, 0.0), 1.8);
  }
  float fade = 1.0 - vT;
  gl_FragColor = vec4(col * alpha * fade * vColor.a, 1.0);
#else
  if (mode == 3) {
    if (max(abs(p.x), abs(p.y)) > 0.8 - vSeed * 0.3) discard;
    alpha = 1.0;
    col *= 0.6 + 0.4 * (1.0 - vUv.y);
  } else {
    vec4 s = texture2D(uSmoke, vUv);
    alpha = s.a;
    // Cheap lighting: brighter on the upper (sunward) side of the puff.
    col *= uAmbient + uSunColor * (0.25 + 0.75 * s.r) * max(uSunDir.y, 0.2) * 0.9;
    if (mode == 1) alpha *= smoothstep(1.0, 0.4, r);
  }
  float fadeIn = smoothstep(0.0, 0.08, vT);
  float fadeOut = 1.0 - smoothstep(0.45, 1.0, vT);
  gl_FragColor = vec4(col, alpha * vColor.a * fadeIn * (mode == 3 ? 1.0 - smoothstep(0.8, 1.0, vT) : fadeOut));
  if (gl_FragColor.a < 0.004) discard;
  #include <fog_fragment>
#endif
#if defined(ADDITIVE) && defined(USE_FOG)
  // Additive light fades to nothing in fog rather than adding fog color.
  #ifdef FOG_EXP2
  float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
  float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb *= 1.0 - fogF;
#endif
}
`;
