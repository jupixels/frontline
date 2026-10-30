import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  KernelSize,
  LookupTexture,
  LUT3DEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  TiltShiftEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Pass,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { Atmosphere } from './environment';
import type { QualitySettings } from './quality';
import { noiseTexture } from './terrain';

/**
 * World-space pass over the depth buffer (sky pixels left alone):
 * - cloud shadows: drifting noise darkens the ground and everything on it (kept mild so teams read);
 * - fog of war: dims never-seen ground and desaturates explored-but-not-visible ground.
 */
class FogOfWarEffect extends Effect {
  constructor(fogTexture: THREE.Texture, bounds: THREE.Vector4) {
    super('FogOfWarEffect', FOG_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['tFog', new THREE.Uniform(fogTexture)],
        ['uFogBounds', new THREE.Uniform(bounds)],
        ['uInvViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uEnabled', new THREE.Uniform(1)],
        ['tCloudNoise', new THREE.Uniform(noiseTexture())],
        // x: threshold, y: darkness, z: 1/scale, w: on
        ['uCloud', new THREE.Uniform(new THREE.Vector4(0, 0, 1, 0))],
        ['uCloudOffset', new THREE.Uniform(new THREE.Vector2())],
      ]),
    });
  }

  setClouds(cover: number, darkness: number, scale: number, on: boolean): void {
    (this.uniforms.get('uCloud')!.value as THREE.Vector4).set(THREE.MathUtils.lerp(0.72, 0.3, cover), darkness, 1 / scale, on ? 1 : 0);
  }

  moveClouds(dx: number, dz: number): void {
    const o = this.uniforms.get('uCloudOffset')!.value as THREE.Vector2;
    o.x += dx;
    o.y += dz;
  }

  setCamera(cam: THREE.Camera): void {
    (this.uniforms.get('uInvViewProj')!.value as THREE.Matrix4).multiplyMatrices(cam.matrixWorld, (cam as THREE.PerspectiveCamera).projectionMatrixInverse);
  }

  set enabled(on: boolean) {
    this.uniforms.get('uEnabled')!.value = on ? 1 : 0;
  }
}

const FOG_FRAG = /* glsl */ `
uniform sampler2D tFog;
uniform vec4 uFogBounds;
uniform mat4 uInvViewProj;
uniform float uEnabled;
uniform sampler2D tCloudNoise;
uniform vec4 uCloud;
uniform vec2 uCloudOffset;
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (depth >= 0.99999 || (uEnabled < 0.5 && uCloud.w < 0.5)) { outputColor = inputColor; return; }
  vec4 wp = uInvViewProj * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  wp /= wp.w;
  vec3 shaded = inputColor.rgb;
  if (uCloud.w > 0.5) {
    vec2 cp = (wp.xz - uCloudOffset) * uCloud.z;
    float n = texture2D(tCloudNoise, cp).r * 0.7 + texture2D(tCloudNoise, cp * 2.3 + 0.31).g * 0.3;
    float shadow = smoothstep(uCloud.x - 0.07, uCloud.x + 0.09, n);
    shaded *= 1.0 - shadow * uCloud.y;
  }
  if (uEnabled < 0.5) { outputColor = vec4(shaded, inputColor.a); return; }
  vec2 fuv = (wp.xz - uFogBounds.xy) / uFogBounds.zw;
  // Outside the playable map: treat as explored scenery.
  vec2 f;
  if (fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0) {
    f = vec2(0.0, 1.0);
  } else {
    // Small blur hides the grid; the texture is low-res on purpose.
    vec2 t = 1.0 / vec2(textureSize(tFog, 0));
    f = texture2D(tFog, fuv).rg * 0.4
      + (texture2D(tFog, fuv + vec2(t.x, 0.0)).rg + texture2D(tFog, fuv - vec2(t.x, 0.0)).rg
      + texture2D(tFog, fuv + vec2(0.0, t.y)).rg + texture2D(tFog, fuv - vec2(0.0, t.y)).rg) * 0.15;
  }
  vec3 c = shaded;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Kept fairly bright on purpose: the battlefield should still read; fog mostly drains color.
  vec3 explored = mix(vec3(lum) * vec3(0.85, 0.9, 1.0), c, 0.5) * 0.7;
  vec3 hidden = mix(vec3(lum) * vec3(0.8, 0.87, 1.0), c, 0.15) * 0.38;
  vec3 res = mix(hidden, explored, smoothstep(0.05, 0.95, f.g));
  res = mix(res, c, smoothstep(0.05, 0.95, f.r));
  outputColor = vec4(res, inputColor.a);
}
`;

/**
 * Heat shimmer: wobbles the image a few pixels with scrolling noise, stronger toward the top of the
 * screen (the distance). Runs in its own pass because it moves UVs for everything after it.
 */
class HeatShimmerEffect extends Effect {
  constructor(strength: number) {
    super('HeatShimmerEffect', SHIMMER_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['tShimmerNoise', new THREE.Uniform(noiseTexture())],
        ['uShimmerTime', new THREE.Uniform(0)],
        ['uShimmer', new THREE.Uniform(strength)],
      ]),
    });
  }

  set time(t: number) {
    this.uniforms.get('uShimmerTime')!.value = t;
  }
}

const SHIMMER_FRAG = /* glsl */ `
uniform sampler2D tShimmerNoise;
uniform float uShimmerTime;
uniform float uShimmer;
void mainUv(inout vec2 uv) {
  float n = texture2D(tShimmerNoise, uv * vec2(9.0, 4.0) + vec2(0.0, uShimmerTime * 0.11)).g
          - texture2D(tShimmerNoise, uv * vec2(5.0, 7.0) - vec2(uShimmerTime * 0.05, 0.0)).b;
  uv.x += n * uShimmer * 0.0035 * smoothstep(0.15, 0.85, uv.y);
}
`;

/** Grade knobs per map mood (see Atmosphere.grade). */
export interface Grade {
  warmth: number;
  saturation: number;
  contrast: number;
}

const DEFAULT_GRADE: Grade = { warmth: 0.3, saturation: 1, contrast: 0.32 };

/**
 * Display-referred color grade baked into a 3D LUT: gentle S-curve, slightly lower saturation in
 * the greens, warm highlights and cool shadows. Input/output are sRGB values in [0,1].
 */
function buildGradeLut(grade: Grade = DEFAULT_GRADE, size = 32): LookupTexture {
  const lut = LookupTexture.createNeutral(size);
  const data = lut.image.data as Float32Array;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    // Contrast S-curve around mid grey.
    const curve = (x: number) => {
      const t = Math.min(Math.max(x, 0), 1);
      const s = t * t * (3 - 2 * t);
      return t + (s - t) * grade.contrast;
    };
    r = curve(r);
    g = curve(g);
    b = curve(b);
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    // Saturation 0.9, pulling greens down a touch more for a dustier, military palette.
    const greenness = Math.max(0, g - Math.max(r, b));
    // Team colors are saturated reds/blues; only greens are pulled down, so units stay readable.
    const sat = (0.92 - greenness * 0.6) * grade.saturation;
    r = l + (r - l) * sat;
    g = l + (g - l) * sat;
    b = l + (b - l) * sat;
    // Split tone.
    const hi = Math.min(Math.max((l - 0.45) / 0.55, 0), 1);
    const lo = 1 - Math.min(Math.max(l / 0.45, 0), 1);
    // Split tone: warm moods push highlights amber, cool moods push them steel blue.
    const w = grade.warmth;
    r += hi * 0.05 * w - lo * 0.02;
    g += hi * 0.02 * w - lo * 0.003;
    b += -hi * 0.045 * w + lo * 0.035;
    data[i] = Math.min(Math.max(r, 0), 1);
    data[i + 1] = Math.min(Math.max(g, 0), 1);
    data[i + 2] = Math.min(Math.max(b, 0), 1);
  }
  lut.needsUpdate = true;
  return lut;
}

/** pmndrs/postprocessing stack: N8AO → [tilt-shift] → (fog of war, bloom, tone mapping, LUT, vignette) → SMAA. */
export class PostStack {
  readonly composer: EffectComposer;
  readonly fog: FogOfWarEffect;
  private lut = buildGradeLut();
  private tiltShift?: TiltShiftEffect;
  private shimmer?: HeatShimmerEffect;
  private mood?: Atmosphere;
  private time = 0;
  private passes: Pass[] = [];
  private disposables: { dispose(): void }[] = [];
  private quality?: QualitySettings;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    fogTexture: THREE.Texture,
    fogBounds: THREE.Vector4,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.fog = new FogOfWarEffect(fogTexture, fogBounds);
  }

  apply(q: QualitySettings): void {
    this.quality = q;
    // EffectPass.dispose() would also dispose the reused fog effect, so passes are only removed and
    // the per-build effects are disposed individually.
    for (const p of this.passes) this.composer.removePass(p);
    for (const d of this.disposables) d.dispose();
    this.passes = [];
    this.disposables = [];
    this.tiltShift = undefined;
    this.shimmer = undefined;

    const add = (p: Pass, disposable = true) => {
      this.passes.push(p);
      if (disposable) this.disposables.push(p);
      this.composer.addPass(p);
    };
    add(new RenderPass(this.scene, this.camera));

    if (q.ao !== 'off') {
      const size = new THREE.Vector2();
      this.renderer.getDrawingBufferSize(size);
      const ao = new N8AOPostPass(this.scene, this.camera, size.x, size.y);
      ao.configuration.aoRadius = 5;
      ao.configuration.distanceFalloff = 1;
      ao.configuration.intensity = 2.2;
      ao.configuration.gammaCorrection = false;
      ao.configuration.transparencyAware = false;
      ao.configuration.halfRes = q.ao === 'half';
      ao.configuration.depthAwareUpsampling = true;
      ao.setQualityMode(q.ao === 'half' ? 'Performance' : q.level === 'ultra' ? 'High' : 'Medium');
      add(ao);
    }

    // Tilt-shift is a convolution: it gets its own pass on the HDR image, before tone mapping.
    if (q.tiltShift) {
      this.tiltShift = new TiltShiftEffect({ focusArea: 0.5, feather: 0.4, kernelSize: KernelSize.MEDIUM });
      add(new EffectPass(this.camera, this.tiltShift));
    }

    // Heat shimmer (hot maps, high presets): bends UVs, so it gets its own pass before the grade.
    if (this.mood && this.mood.shimmer > 0 && (q.level === 'high' || q.level === 'ultra')) {
      this.shimmer = new HeatShimmerEffect(this.mood.shimmer);
      add(new EffectPass(this.camera, this.shimmer));
    }

    const effects: Effect[] = [this.fog];
    if (q.bloom) {
      effects.push(
        new BloomEffect({
          intensity: 1.1,
          luminanceThreshold: 1.1,
          luminanceSmoothing: 0.35,
          mipmapBlur: true,
          radius: 0.7,
        }),
      );
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    effects.push(new LUT3DEffect(this.lut));
    effects.push(new VignetteEffect({ offset: 0.32, darkness: 0.42, blendFunction: BlendFunction.NORMAL }));
    for (const e of effects) if (e !== this.fog) this.disposables.push(e);
    add(new EffectPass(this.camera, ...effects), false);
    if (q.smaa) add(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  /** Map mood: cloud shadows, heat shimmer and color grade. Call before apply(). */
  setMood(a: Atmosphere): void {
    this.mood = a;
    this.lut.dispose();
    this.lut = buildGradeLut(a.grade);
    this.fog.setClouds(a.clouds.cover, a.clouds.darkness, a.clouds.scale, a.clouds.cover > 0);
    if (this.quality) this.apply(this.quality);
  }

  /** `zoom` in [0,1]: 0 = fully zoomed in. Tilt-shift fades out as the camera pulls back. */
  render(dt: number, zoom: number): void {
    this.time += dt;
    if (this.mood) {
      // Clouds drift downwind at 4-14 m/s.
      const speed = 4 + this.mood.wind.strength * 10;
      this.fog.moveClouds(Math.sin(this.mood.wind.heading) * speed * dt, Math.cos(this.mood.wind.heading) * speed * dt);
    }
    if (this.shimmer) this.shimmer.time = this.time;
    this.fog.setCamera(this.camera);
    if (this.tiltShift) this.tiltShift.blendMode.opacity.value = THREE.MathUtils.clamp(1 - zoom * 2.2, 0, 1);
    this.composer.render(dt);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.fog.dispose();
    this.lut.dispose();
    this.composer.dispose();
  }

  get qualityLevel(): string | undefined {
    return this.quality?.level;
  }
}
