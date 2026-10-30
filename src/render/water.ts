import * as THREE from 'three';
import type { Atmosphere } from './environment';
import { noiseTexture, WATER_LEVEL, type Terrain } from './terrain';

/**
 * Animated water plane:
 * - wind-driven wave normals (four directional noise octaves, choppier on windy maps) with whitecaps;
 * - color by depth from the terrain height texture: clear sandy edge → turquoise shallows → dark deep;
 * - Fresnel reflection of the map's sky (gradient + drifting clouds) and a sun glint;
 * - soft shoreline foam: a wet fringe plus foam lines rolling in, broken up by multi-octave noise;
 * - ship wakes from the decal map's B channel as turbulent foam that also roughens the surface.
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
        uShallow: { value: new THREE.Color(0x2f8a82) },
        uWind: { value: new THREE.Vector2(0.6, 0.8) },
        uWaves: { value: 1 },
        uGlint: { value: 1 },
        uCloud: { value: new THREE.Vector3(0.5, 0.3, 1 / 260) },
        tHeight: { value: null },
        tNoise: { value: null },
        uTerrainBounds: { value: null },
        tDecal: { value: null },
        uDecalBounds: { value: new THREE.Vector4(-1, -1, 2, 2) },
        uLevel: { value: WATER_LEVEL },
      },
    ]);
    // These must stay shared objects, not merge() copies.
    this.uniforms.tHeight.value = terrain.heightTexture;
    this.uniforms.tNoise.value = noiseTexture();
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

  /** Colors, sky, wind and wave height from the map's atmosphere. */
  setMood(a: Atmosphere): void {
    const u = this.uniforms;
    if (a.water) {
      (u.uShallow.value as THREE.Color).set(a.water[0]);
      (u.uDeep.value as THREE.Color).set(a.water[1]);
    }
    (u.uSkyZenith.value as THREE.Color).set(a.hemiSky).multiplyScalar(0.75);
    (u.uSkyHorizon.value as THREE.Color).set(a.fogColor);
    (u.uWind.value as THREE.Vector2).set(Math.sin(a.wind.heading), Math.cos(a.wind.heading));
    u.uWaves.value = a.waves;
    // Sun glitter only under a clear sky.
    u.uGlint.value = (1 - a.clouds.cover * 0.6) * (1 - a.rain) * (1 - a.rain);
    (u.uCloud.value as THREE.Vector3).set(a.clouds.cover, a.clouds.darkness, 1 / a.clouds.scale);
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
uniform vec2 uWind;
uniform float uWaves;
uniform float uGlint;
uniform vec3 uCloud;
uniform sampler2D tHeight;
uniform sampler2D tNoise;
uniform vec4 uTerrainBounds;
uniform sampler2D tDecal;
uniform vec4 uDecalBounds;
uniform float uLevel;
varying vec3 vWorld;

// Wave height: four noise octaves travelling roughly downwind at different angles and speeds.
float waves(vec2 p) {
  float t = uTime;
  vec2 w = uWind;
  vec2 wp = vec2(-w.y, w.x);
  float h = 0.0;
  h += texture2D(tNoise, p * 0.0042 - w * t * 0.004).r * 1.0;
  h += texture2D(tNoise, (p * 0.011 + (w * 0.8 + wp * 0.4) * t * -0.011)).g * 0.55;
  h += texture2D(tNoise, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.019 - (w * 0.7 - wp * 0.5) * t * 0.02).g * 0.3;
  h += texture2D(tNoise, p * 0.05 - w * t * 0.045).b * 0.06;
  return h;
}

void main() {
  vec2 p = vWorld.xz;
  float e = 0.6;
  float h0 = waves(p);
  // Flatter far away: the fine octaves alias into sparkle at RTS distances.
  float far = smoothstep(80.0, 400.0, length(cameraPosition - vWorld));
  float slope = 0.9 * uWaves * (2.4 - far * 1.2);
  vec3 n = normalize(vec3((h0 - waves(p + vec2(e, 0.0))) / e * slope, 1.0, (h0 - waves(p + vec2(0.0, e))) / e * slope));

  // Depth from the terrain heightfield.
  float ground = texture2D(tHeight, (p - uTerrainBounds.xy) / uTerrainBounds.zw).r;
  float depth = max(uLevel - ground, 0.0);

  // Ship wakes roughen the surface as well as foaming it.
  vec2 dUv = (p - uDecalBounds.xy) / uDecalBounds.zw;
  float wake = (dUv.x > 0.0 && dUv.x < 1.0 && dUv.y > 0.0 && dUv.y < 1.0) ? texture2D(tDecal, dUv).b : 0.0;
  vec2 wn = texture2D(tNoise, p * 0.09 + uTime * 0.05).gb - 0.5;
  n = normalize(n + vec3(wn.x, 0.0, wn.y) * wake * 0.9);
  // Calm near the shore.
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, 0.35 + 0.65 * smoothstep(0.0, 2.5, depth)));

  vec3 viewDir = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, viewDir), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // Sky reflection: the map's sky gradient with clouds drifting through it.
  vec3 r = reflect(-viewDir, n);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, clamp(r.y * 1.4, 0.0, 1.0));
  vec2 cuv = (p + r.xz / max(r.y, 0.08) * 160.0) * uCloud.z * 0.6 + uWind * uTime * 0.003;
  float cloud = smoothstep(mix(0.72, 0.3, uCloud.x) - 0.08, mix(0.72, 0.3, uCloud.x) + 0.12, texture2D(tNoise, cuv).r);
  sky = mix(sky, uSkyHorizon * 1.15 + 0.05, cloud * 0.55);
  float sd = max(dot(r, uSunDir), 0.0);
  float glint = (pow(sd, 900.0 / (0.6 + uWaves)) * 18.0 + pow(sd, 70.0) * 0.35) * uGlint;

  // Body color by depth: sandy see-through edge, turquoise shallows, dark deep water.
  float absorb = 1.0 - exp(-depth * 0.16);
  vec3 body = mix(uShallow, uDeep, absorb);
  vec3 lagoon = uShallow * vec3(1.05, 1.18, 1.08) + vec3(0.02, 0.05, 0.04);
  body = mix(lagoon, body, smoothstep(0.4, 4.0, depth));
  body *= 0.3 + 0.7 * max(uSunDir.y, 0.0);
  // Light through wave crests.
  body += uShallow * smoothstep(0.55, 0.85, h0 / 1.99) * 0.25 * uWaves;

  vec3 col = mix(body, sky, fresnel * (1.0 - cloud * 0.3)) + uSunColor * glint * (1.0 - cloud * 0.8);

  // Shoreline: soft foam lines rolling in, broken up by multi-octave noise.
  float fn = texture2D(tNoise, p * 0.06 + uWind * uTime * 0.01).b * 0.55
           + texture2D(tNoise, p * 0.17 - uTime * 0.012).g * 0.45;
  float shoreBand = smoothstep(2.2, 0.15, depth);
  float roll = sin(depth * 4.2 - uTime * 1.3 + fn * 5.0) * 0.5 + 0.5;
  float lines = smoothstep(0.62, 0.95, roll) * smoothstep(0.38, 0.62, fn);
  float fringe = smoothstep(0.35, 0.02, depth) * smoothstep(0.3, 0.6, fn + 0.15);
  float foam = shoreBand * lines * 0.8 + fringe * 0.7;
  // Whitecaps on windy water: wave crests that break.
  float crest = smoothstep(1.4 - uWaves * 0.1, 1.85, h0) * smoothstep(0.35, 0.75, fn);
  foam = max(foam, crest * smoothstep(1.0, 1.5, uWaves) * smoothstep(3.0, 8.0, depth) * 0.4);
  // Wakes: churned white water that thins into lace.
  float lace = smoothstep(0.25, 0.65, fn + wake * 0.45);
  foam = max(foam, wake * lace);
  vec3 foamCol = vec3(0.88, 0.92, 0.93) * (0.45 + 0.55 * max(uSunDir.y, 0.0));
  col = mix(col, foamCol, clamp(foam, 0.0, 1.0));

  // The very edge fades out so the wet sand shows through; foam stays visible.
  float alpha = clamp(smoothstep(0.0, 1.2, depth) * 0.82 + fresnel * 0.6 + foam * 0.8, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
