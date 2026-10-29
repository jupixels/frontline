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
import type { QualitySettings } from './quality';

/**
 * Darkens never-seen ground to near black and desaturates explored-but-not-visible ground,
 * by reconstructing each pixel's world position from depth and sampling the fog texture.
 * Sky pixels (no depth) are left alone.
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
      ]),
    });
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
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (uEnabled < 0.5 || depth >= 0.99999) { outputColor = inputColor; return; }
  vec4 wp = uInvViewProj * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  wp /= wp.w;
  vec2 fuv = (wp.xz - uFogBounds.xy) / uFogBounds.zw;
  // Outside the playable map: treat as explored scenery.
  vec2 f = (fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0) ? vec2(0.0, 1.0) : texture2D(tFog, fuv).rg;
  vec3 c = inputColor.rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 explored = mix(vec3(lum) * vec3(0.82, 0.88, 1.0), c, 0.35) * 0.48;
  vec3 hidden = c * 0.05;
  vec3 res = mix(hidden, explored, smoothstep(0.0, 1.0, f.g));
  res = mix(res, c, smoothstep(0.0, 1.0, f.r));
  outputColor = vec4(res, inputColor.a);
}
`;

/**
 * Display-referred color grade baked into a 3D LUT: gentle S-curve, slightly lower saturation in
 * the greens, warm highlights and cool shadows. Input/output are sRGB values in [0,1].
 */
function buildGradeLut(size = 32): LookupTexture {
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
      return t + (s - t) * 0.32;
    };
    r = curve(r);
    g = curve(g);
    b = curve(b);
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    // Saturation 0.9, pulling greens down a touch more for a dustier, military palette.
    const greenness = Math.max(0, g - Math.max(r, b));
    const sat = 0.92 - greenness * 0.6;
    r = l + (r - l) * sat;
    g = l + (g - l) * sat;
    b = l + (b - l) * sat;
    // Split tone.
    const hi = Math.min(Math.max((l - 0.45) / 0.55, 0), 1);
    const lo = 1 - Math.min(Math.max(l / 0.45, 0), 1);
    r += hi * 0.035 - lo * 0.02;
    g += hi * 0.015 - lo * 0.003;
    b += -hi * 0.03 + lo * 0.035;
    data[i] = Math.min(Math.max(r, 0), 1);
    data[i + 1] = Math.min(Math.max(g, 0), 1);
    data[i + 2] = Math.min(Math.max(b, 0), 1);
  }
  lut.needsUpdate = true;
  return lut;
}

/** pmndrs/postprocessing stack: N8AO → (fog of war, bloom, tone mapping, LUT, vignette, tilt-shift) → SMAA. */
export class PostStack {
  readonly composer: EffectComposer;
  readonly fog: FogOfWarEffect;
  private readonly lut = buildGradeLut();
  private tiltShift?: TiltShiftEffect;
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
    if (q.tiltShift) {
      this.tiltShift = new TiltShiftEffect({ focusArea: 0.55, feather: 0.35, kernelSize: KernelSize.MEDIUM });
      effects.push(this.tiltShift);
    }
    for (const e of effects) if (e !== this.fog) this.disposables.push(e);
    add(new EffectPass(this.camera, ...effects), false);
    if (q.smaa) add(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  /** `zoom` in [0,1]: 0 = fully zoomed in. Tilt-shift fades out as the camera pulls back. */
  render(dt: number, zoom: number): void {
    this.fog.setCamera(this.camera);
    if (this.tiltShift) this.tiltShift.blendMode.opacity.value = THREE.MathUtils.clamp(1 - zoom * 2.2, 0, 1);
    this.composer.render(dt);
  }

  get qualityLevel(): string | undefined {
    return this.quality?.level;
  }
}
