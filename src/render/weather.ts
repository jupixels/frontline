import * as THREE from 'three';
import type { Atmosphere } from './environment';
import type { QualitySettings } from './quality';

/** Size of the box of rain that follows the view center (meters). */
const BOX = 140;
const HEIGHT = 70;

/**
 * Drifting rain: thin streaks in a box that follows the camera's view center, animated entirely on
 * the GPU (each drop wraps around the box by time), slanted by the map's wind. One draw call.
 */
export class Weather {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2() },
    uOpacity: { value: 0.3 },
  };
  private readonly intensity: number;

  constructor(atmosphere: Atmosphere) {
    this.intensity = atmosphere.rain;
    const w = atmosphere.wind;
    // Horizontal drift in m/s.
    this.uniforms.uWind.value.set(Math.sin(w.heading), Math.cos(w.heading)).multiplyScalar(2 + w.strength * 7);
    this.uniforms.uOpacity.value = 0.18 + atmosphere.rain * 0.17;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    Object.assign(mat.uniforms, this.uniforms);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'rain';
    this.mesh.visible = false;
  }

  setQuality(q: QualitySettings): void {
    const n = Math.round(q.rainDrops * this.intensity);
    if (n === this.geo.instanceCount) return;
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  update(center: THREE.Vector3, time: number): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uCenter.value.copy(center);
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const RAIN_VERT = /* glsl */ `
#include <fog_pars_vertex>
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCenter;
uniform vec2 uWind;
varying float vAlpha;
varying float vV;
const float BOX = ${BOX.toFixed(1)};
const float HEIGHT = ${HEIGHT.toFixed(1)};
void main() {
  float fall = 18.0 + aSeed.w * 8.0;
  float t = uTime + aSeed.z * 50.0;
  // Each drop loops through the box; x/z wrap around the view center so the box follows the camera.
  float y = HEIGHT - mod(t * fall, HEIGHT);
  vec2 xz = aSeed.xy * BOX + uWind * t;
  xz = mod(xz - uCenter.xz + BOX * 0.5, BOX) + uCenter.xz - BOX * 0.5;
  vec3 base = vec3(xz.x, uCenter.y + y - 8.0, xz.y);
  // Streak along the velocity, facing the camera.
  vec3 vel = normalize(vec3(uWind.x, -fall, uWind.y));
  vec3 toCam = normalize(cameraPosition - base);
  vec3 side = normalize(cross(vel, toCam));
  // Keep streaks about a pixel wide at RTS distances.
  float dist = length(cameraPosition - base);
  float len = (1.6 + aSeed.w * 1.2) * max(1.0, dist * 0.012);
  vec3 p = base + side * position.x * max(0.05, dist * 0.0022) - vel * position.y * len;
  vV = position.y;
  // Fade at the top and bottom of the box and in the outer ring.
  float edge = 1.0 - smoothstep(BOX * 0.35, BOX * 0.5, length(xz - uCenter.xz));
  vAlpha = smoothstep(0.0, 6.0, y) * smoothstep(HEIGHT, HEIGHT - 10.0, y) * edge;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RAIN_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uOpacity;
varying float vAlpha;
varying float vV;
void main() {
  gl_FragColor = vec4(vec3(0.78, 0.82, 0.86), uOpacity * vAlpha * (0.4 + 0.6 * vV));
  #include <fog_fragment>
}
`;
