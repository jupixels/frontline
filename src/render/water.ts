import * as THREE from 'three';
import { WATER_LEVEL, type Terrain } from './terrain';

/**
 * Animated water plane: procedural wave normals, Fresnel sky reflection with sun glint,
 * depth-tinted absorption from the terrain height texture, shoreline foam, and ship-wake foam
 * read from the decal map's B channel.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(terrain: Terrain, sunDir: THREE.Vector3, sunColor: THREE.Color) {
    const size = terrain.extent;
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: sunDir.clone().normalize() },
        uSunColor: { value: sunColor.clone() },
        uSkyZenith: { value: new THREE.Color(0x3d6b9a) },
        uSkyHorizon: { value: new THREE.Color(0xb8c8d2) },
        uDeep: { value: new THREE.Color(0x0b2a33) },
        uShallow: { value: new THREE.Color(0x2f7a78) },
        tHeight: { value: terrain.heightTexture },
        uTerrainBounds: { value: terrain.uniforms.uTerrainBounds.value },
        tDecal: { value: null },
        uDecalBounds: { value: new THREE.Vector4(-1, -1, 2, 2) },
        uLevel: { value: WATER_LEVEL },
      },
    ]);
    // These must stay shared objects, not merge() copies.
    this.uniforms.tHeight.value = terrain.heightTexture;
    this.uniforms.uTerrainBounds.value = terrain.uniforms.uTerrainBounds.value;

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      fog: true,
      depthWrite: true,
    });
    const geo = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = WATER_LEVEL;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'water';
  }

  setDecals(tex: THREE.Texture, bounds: THREE.Vector4): void {
    this.uniforms.tDecal.value = tex;
    (this.uniforms.uDecalBounds.value as THREE.Vector4).copy(bounds);
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }
}

const WATER_VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform sampler2D tHeight;
uniform vec4 uTerrainBounds;
uniform sampler2D tDecal;
uniform vec4 uDecalBounds;
uniform float uLevel;
varying vec3 vWorld;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
// Height of a few scrolling noise layers; normals come from its gradient.
float waves(vec2 p) {
  float t = uTime;
  float h = 0.0;
  h += vnoise(p * 0.08 + vec2(t * 0.05, t * 0.03)) * 1.0;
  h += vnoise(p * 0.21 + vec2(-t * 0.09, t * 0.07)) * 0.5;
  h += vnoise(mat2(0.8, -0.6, 0.6, 0.8) * p * 0.55 + vec2(t * 0.16, -t * 0.12)) * 0.22;
  h += vnoise(p * 1.4 + vec2(-t * 0.3, -t * 0.25)) * 0.08;
  return h;
}

void main() {
  vec2 p = vWorld.xz;
  float e = 0.15;
  float h0 = waves(p);
  vec3 n = normalize(vec3((h0 - waves(p + vec2(e, 0.0))) / e * 0.35, 1.0, (h0 - waves(p + vec2(0.0, e))) / e * 0.35));

  vec3 viewDir = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, viewDir), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 r = reflect(-viewDir, n);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, clamp(r.y * 1.6, 0.0, 1.0));
  float spec = pow(max(dot(r, uSunDir), 0.0), 600.0) * 40.0 + pow(max(dot(r, uSunDir), 0.0), 60.0) * 0.6;

  float ground = texture2D(tHeight, (p - uTerrainBounds.xy) / uTerrainBounds.zw).r;
  float depth = max(uLevel - ground, 0.0);
  float absorb = 1.0 - exp(-depth * 0.35);
  vec3 body = mix(uShallow, uDeep, absorb);
  // Light scattered into the water body.
  body *= 0.25 + 0.75 * max(uSunDir.y, 0.0);

  vec3 col = mix(body, sky, fresnel) + uSunColor * spec;

  // Shoreline foam: bands that drift toward the shore and break up with noise.
  float shore = smoothstep(1.4, 0.0, depth);
  float bands = sin(depth * 9.0 - uTime * 1.6 + vnoise(p * 0.3) * 6.0) * 0.5 + 0.5;
  float foamNoise = vnoise(p * 1.7 + uTime * 0.2);
  float foam = shore * smoothstep(0.55, 0.95, bands * 0.6 + foamNoise * 0.6) + smoothstep(0.25, 0.0, depth) * 0.8;

  vec2 dUv = (p - uDecalBounds.xy) / uDecalBounds.zw;
  float wake = (dUv.x > 0.0 && dUv.x < 1.0 && dUv.y > 0.0 && dUv.y < 1.0) ? texture2D(tDecal, dUv).b : 0.0;
  foam = max(foam, wake * smoothstep(0.3, 0.7, foamNoise + wake * 0.5));
  col = mix(col, vec3(0.85, 0.9, 0.92) * (0.5 + 0.5 * max(uSunDir.y, 0.0)), clamp(foam, 0.0, 1.0));

  // Shallow water fades out so the beach shows through.
  float alpha = clamp(smoothstep(0.0, 1.8, depth) * 0.85 + fresnel + foam, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
