import * as THREE from 'three';

/** How a source material is treated on a team's unit. */
export type MaterialRole = 'camo' | 'accent' | 'stripe' | 'keep';

/**
 * Classify glTF materials. The main hull (or an untextured/default material) gets team camo,
 * small colored trim becomes a team-color accent, and glass/lights/tyres/metal are kept.
 */
export function materialRole(mat: THREE.Material, isPrimary: boolean): MaterialRole {
  const m = mat as THREE.MeshStandardMaterial;
  const name = mat.name.toLowerCase();
  if (/glass|window|light|lamp|wheel|tyre|tire|track|black|metal|barrel|bolt|sign/.test(name)) return 'keep';
  // Textured hulls keep their paint and get a team-color stripe instead.
  if (m.map) return isPrimary ? 'stripe' : 'keep';
  if (isPrimary || /body|hull|green|camo/.test(name)) return 'camo';
  // Unnamed secondary materials are usually running gear; leave them alone.
  return name === '' ? 'keep' : 'accent';
}

export interface CamoOptions {
  team: THREE.Color;
  /** Scale of the camo blotches in meters. */
  scale?: number;
  /** Charred wreck look. */
  burnt?: boolean;
  /** Read the team color from per-instance color instead of the uniform (instanced infantry). */
  instanced?: boolean;
  /** Skinned/morphed meshes need the same flags the original material had. */
  base?: THREE.MeshStandardMaterial;
}

/**
 * Procedural three-tone woodland camo in object space, with the mid tone pulled toward the team
 * color so ownership reads at RTS distance, plus edge wear and dust toward the bottom.
 */
export function createCamoMaterial(opts: CamoOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: opts.burnt ? 1 : 0.7,
    metalness: opts.burnt ? 0 : 0.1,
  });
  if (opts.base) {
    mat.side = opts.base.side;
    mat.flatShading = opts.base.flatShading;
  }
  const uniforms = {
    uTeam: { value: opts.team.clone() },
    uCamoScale: { value: 1 / (opts.scale ?? 2.2) },
    uBurnt: { value: opts.burnt ? 1 : 0 },
  };
  const instanced = !!opts.instanced;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CAMO_HEAD}`)
      .replace('#include <color_fragment>', instanced ? CAMO_INSTANCED : CAMO_UNIFORM)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + camoRough, 0.0, 1.0);');
  };
  mat.customProgramCacheKey = () => `camo-${instanced ? 'i' : 'u'}`;
  mat.userData.camoUniforms = uniforms;
  return mat;
}

/** Team accent trim: the team color as a semi-gloss painted surface. */
export function createAccentMaterial(team: THREE.Color, source: THREE.Material, burnt = false): THREE.MeshStandardMaterial {
  const m = (source as THREE.MeshStandardMaterial).clone();
  m.color = burnt ? new THREE.Color(0x141210) : team.clone().multiplyScalar(0.55);
  m.roughness = burnt ? 1 : 0.5;
  m.metalness = burnt ? 0 : 0.2;
  m.map = null;
  return m;
}

/** Darken a kept material for wrecks. */
export function createBurntMaterial(source: THREE.Material): THREE.Material {
  const m = (source as THREE.MeshStandardMaterial).clone();
  if (m.color) m.color.multiplyScalar(0.12).lerp(new THREE.Color(0x0e0c0a), 0.6);
  if ('emissive' in m && m.emissive) m.emissive.setRGB(0, 0, 0);
  if ('roughness' in m) m.roughness = 1;
  if ('metalness' in m) m.metalness = 0;
  m.transparent = false;
  m.opacity = 1;
  return m;
}

const CAMO_HEAD = /* glsl */ `
uniform vec3 uTeam;
uniform float uCamoScale;
uniform float uBurnt;
varying vec3 vObjPos;
varying vec3 vObjNormal;
float camoHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float camoNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(camoHash(i + vec3(0, 0, 0)), camoHash(i + vec3(1, 0, 0)), f.x),
                 mix(camoHash(i + vec3(0, 1, 0)), camoHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(camoHash(i + vec3(0, 0, 1)), camoHash(i + vec3(1, 0, 1)), f.x),
                 mix(camoHash(i + vec3(0, 1, 1)), camoHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float camoRough = 0.0;
vec3 camoColor(vec3 team) {
  vec3 p = vObjPos * uCamoScale;
  float n1 = camoNoise(p) * 0.65 + camoNoise(p * 2.3 + 7.1) * 0.35;
  float n2 = camoNoise(p * 1.3 + 31.7) * 0.65 + camoNoise(p * 2.9 + 3.3) * 0.35;
  // Team-tinted base, olive-drab and near-black blotches.
  // Real paint albedo is low (~0.1); the team hue is strong but kept dark so it doesn't glow.
  vec3 base = mix(vec3(0.075, 0.08, 0.055), team * 0.42, 0.7);
  vec3 drab = vec3(0.05, 0.052, 0.034);
  vec3 dark = vec3(0.014, 0.014, 0.012);
  vec3 c = base;
  c = mix(c, drab, smoothstep(0.5, 0.54, n1));
  c = mix(c, dark, smoothstep(0.6, 0.64, n2));
  // Grime: dust toward the bottom, faint vertical streaks.
  float fine = camoNoise(vObjPos * 9.0);
  float lowDust = smoothstep(0.9, 0.0, vObjPos.y) * 0.45;
  c = mix(c, vec3(0.13, 0.11, 0.08), lowDust * (0.6 + 0.4 * fine));
  c *= 0.88 + 0.24 * camoNoise(vec3(vObjPos.x * 6.0, vObjPos.y * 0.7, vObjPos.z * 6.0));
  // Slight roughness variation so the paint doesn't look plastic.
  camoRough = (fine - 0.5) * 0.15;
  if (uBurnt > 0.5) {
    float soot = camoNoise(vObjPos * 3.0);
    c = mix(vec3(0.018, 0.016, 0.014), vec3(0.06, 0.045, 0.035), soot);
    c += vec3(0.08, 0.035, 0.01) * smoothstep(0.75, 0.95, fine) * 0.4;
    camoRough = 0.3;
  }
  return c;
}
`;

const CAMO_UNIFORM = /* glsl */ `
diffuseColor.rgb = camoColor(uTeam);
`;

const CAMO_INSTANCED = /* glsl */ `
#ifdef USE_INSTANCING_COLOR
diffuseColor.rgb = camoColor(vColor);
#else
diffuseColor.rgb = camoColor(uTeam);
#endif
`;

/** Textured material plus a team-color band around the hull between `band.x` and `band.y` meters (object space). */
export function createStripeMaterial(source: THREE.Material, team: THREE.Color, band: THREE.Vector2): THREE.Material {
  const m = (source as THREE.MeshStandardMaterial).clone();
  const uniforms = { uTeam: { value: team.clone() }, uBand: { value: band.clone() } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTeam;\nuniform vec2 uBand;\nvarying vec3 vObjPos;')
      .replace('#include <map_fragment>', STRIPE_FRAG);
  };
  m.customProgramCacheKey = () => 'team-stripe';
  return m;
}

const STRIPE_FRAG = /* glsl */ `
#include <map_fragment>
float stripe = smoothstep(uBand.x - 0.02, uBand.x, vObjPos.y) * smoothstep(uBand.y + 0.02, uBand.y, vObjPos.y);
diffuseColor.rgb = mix(diffuseColor.rgb, uTeam * 0.8, stripe);
`;

const cache = new Map<string, THREE.Material>();

/**
 * Per-team material for a source material, cached so every unit of a team shares programs and
 * uniforms. `role` comes from `materialRole`.
 */
export function teamMaterial(
  source: THREE.Material,
  role: MaterialRole,
  team: THREE.Color,
  burnt: boolean,
  camoScale = 2.2,
  stripeBand = new THREE.Vector2(0.9, 1.1),
): THREE.Material {
  const key = `${source.uuid}|${role}|${team.getHexString()}|${burnt ? 1 : 0}`;
  let m = cache.get(key);
  if (!m) {
    if (role === 'camo') m = createCamoMaterial({ team, burnt, base: source as THREE.MeshStandardMaterial, scale: camoScale });
    else if (role === 'accent') m = createAccentMaterial(team, source, burnt);
    else if (role === 'stripe') m = burnt ? createBurntMaterial(source) : createStripeMaterial(source, team, stripeBand);
    else m = burnt ? createBurntMaterial(source) : source;
    cache.set(key, m);
  }
  return m;
}
