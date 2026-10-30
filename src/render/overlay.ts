import * as THREE from 'three';

const MAX_BARS = 1024;

/**
 * Screen-space health bars in one instanced draw. Rendered in a separate overlay pass after post
 * processing so tone mapping and bloom don't touch them.
 */
export class HealthBars {
  readonly mesh: THREE.Mesh;
  private readonly aWorld: THREE.InstancedBufferAttribute;
  private readonly aData: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly viewport: THREE.Vector2;
  private count = 0;
  private readonly time = { value: 0 };

  constructor() {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aWorld = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aWorld', this.aWorld);
    geo.setAttribute('aData', this.aData);
    geo.instanceCount = 0;
    this.geo = geo;
    this.viewport = new THREE.Vector2(1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uViewport: { value: this.viewport }, uTime: this.time },
      vertexShader: BAR_VERT,
      fragmentShader: BAR_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  setViewport(w: number, h: number): void {
    this.viewport.set(w, h);
  }

  /** `time` in seconds drives the pulse on badly hurt units. */
  begin(time = 0): void {
    this.count = 0;
    this.time.value = time;
  }

  /** `widthPx` in CSS pixels; `selected` draws a brighter frame; `progress` draws a blue build bar. */
  add(pos: THREE.Vector3, fill: number, widthPx: number, selected: boolean, progress = false): void {
    if (this.count >= MAX_BARS) return;
    const i = this.count++;
    this.aWorld.setXYZ(i, pos.x, pos.y, pos.z);
    this.aData.setXYZW(i, THREE.MathUtils.clamp(fill, 0, 1), widthPx, selected ? 1 : 0, progress ? 1 : 0);
  }

  end(): void {
    this.geo.instanceCount = this.count;
    if (!this.count) return;
    for (const a of [this.aWorld, this.aData]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

const BAR_VERT = /* glsl */ `
attribute vec3 aWorld;
attribute vec4 aData;
uniform vec2 uViewport;
varying vec2 vUv;
varying vec4 vData;
void main() {
  vUv = position.xy + 0.5;
  vData = aData;
  vec4 clip = projectionMatrix * viewMatrix * vec4(aWorld, 1.0);
  // Full health: a thin, quiet bar. Damaged: taller, so hurt units stand out.
  bool full = aData.x > 0.995 && aData.w < 0.5;
  vec2 sizePx = vec2(aData.y, full ? 3.5 : 6.0);
  clip.xy += position.xy * sizePx / uViewport * 2.0 * clip.w;
  gl_Position = clip;
}
`;

const BAR_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec4 vData;
void main() {
  float fill = vData.x;
  bool progress = vData.w > 0.5;
  bool full = fill > 0.995 && !progress;
  vec3 hpColor = progress ? vec3(0.35, 0.7, 1.0)
    : fill > 0.6 ? vec3(0.5, 1.0, 0.38) : fill > 0.3 ? vec3(1.0, 0.84, 0.25) : vec3(1.0, 0.3, 0.2);
  // Badly hurt units pulse so they catch the eye; healthy ones sit back.
  if (!progress && fill <= 0.3) hpColor *= 1.0 + 0.35 * (0.5 + 0.5 * sin(uTime * 7.0));
  else if (!full && !progress) hpColor *= 1.12;
  // A thin highlight along the top of the fill reads as a lit, raised bar.
  if (!full) hpColor = mix(hpColor, vec3(1.0), 0.25 * smoothstep(0.55, 0.9, vUv.y));
  vec3 c = vUv.x < fill ? hpColor : vec3(0.08, 0.09, 0.08);
  // 1px-ish frame.
  vec2 px = fwidth(vUv);
  float edge = step(vUv.x, px.x) + step(1.0 - px.x, vUv.x) + step(vUv.y, px.y) + step(1.0 - px.y, vUv.y);
  c = mix(c, vData.z > 0.5 ? vec3(0.85) : vec3(0.0), clamp(edge, 0.0, 1.0));
  gl_FragColor = vec4(c, full ? 0.6 : 0.95);
}
`;

const MAX_RINGS = 2048;

export type TeamRingMode = 'always' | 'far' | 'off';

/**
 * Small team-colored rings on the ground under units, one instanced draw. They fade in as the camera
 * pulls back (or stay on, per setting) and keep a minimum on-screen size, so a distant army still
 * reads by side when the models are a few pixels tall.
 */
export class TeamRings {
  readonly mesh: THREE.Mesh;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly always = { value: 0 };
  private count = 0;
  mode: TeamRingMode = 'far';

  constructor() {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    // Laid flat (y → world z), so wound the other way round to face up.
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aColor', this.aColor);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAlways: this.always },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  begin(): void {
    this.count = 0;
    this.always.value = this.mode === 'always' ? 1 : 0;
  }

  /** A ring of `radius` meters on the ground at `pos`. */
  add(pos: THREE.Vector3, radius: number, color: THREE.Color): void {
    if (this.mode === 'off' || this.count >= MAX_RINGS) return;
    const i = this.count++;
    this.aPos.setXYZW(i, pos.x, pos.y, pos.z, radius);
    this.aColor.setXYZ(i, color.r, color.g, color.b);
  }

  end(): void {
    this.geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (!this.count) return;
    for (const a of [this.aPos, this.aColor]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

const RING_VERT = /* glsl */ `
attribute vec4 aPos;
attribute vec3 aColor;
uniform float uAlways;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float dist = distance(cameraPosition, aPos.xyz);
  // Far zoom fades the rings in; up close they'd only clutter the models.
  float far = smoothstep(150.0, 260.0, dist);
  vAlpha = uAlways > 0.5 ? max(far, 0.6) : far;
  // Never smaller than a few pixels: grows with distance past the unit's own size.
  float r = max(aPos.w, dist * 0.008);
  vUv = position.xy;
  vColor = aColor;
  vec3 world = aPos.xyz + vec3(position.x * r, 0.0, position.y * r);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  if (vAlpha <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(vUv);
  float aa = fwidth(d) * 1.5;
  float band = smoothstep(0.66 - aa, 0.66, d) * (1.0 - smoothstep(1.0 - aa, 1.0, d));
  float fill = (1.0 - smoothstep(0.66 - aa, 0.66, d)) * 0.16;
  float a = (band + fill) * vAlpha;
  if (a < 0.01) discard;
  // Saturated team color (tone mapping in post would wash a lighter one out to white).
  gl_FragColor = vec4(vColor * 1.1, a);
}
`;

interface Marker {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  kind: 'ring' | 'target' | 'incoming';
  follow?: () => THREE.Vector3 | null;
}

const MOVE_COLOR = new THREE.Color(0x8dff6e);
const ATTACK_COLOR = new THREE.Color(0xff5a36);
const BUILD_COLOR = new THREE.Color(0x6ec8ff);

/** Ground markers for orders: move/attack-move rings, attack target brackets, rally lines. */
export class CommandMarkers {
  readonly group = new THREE.Group();
  private readonly markers: Marker[] = [];
  private readonly ringGeo = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
  private readonly dotGeo = new THREE.CircleGeometry(0.22, 16).rotateX(-Math.PI / 2);
  private readonly bracketGeo = buildBracketGeometry();
  private readonly rallyLines = new Map<number, THREE.Mesh>();

  constructor(private readonly heightAt: (x: number, z: number) => number) {}

  private material(color: THREE.Color): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false });
  }

  /** Move (green) or attack-move (red) marker at a ground point. */
  ground(x: number, z: number, kind: 'move' | 'attackMove' | 'build'): void {
    const color = kind === 'move' ? MOVE_COLOR : kind === 'build' ? BUILD_COLOR : ATTACK_COLOR;
    const mat = this.material(color);
    const ring = new THREE.Mesh(this.ringGeo, mat);
    const dot = new THREE.Mesh(this.dotGeo, mat);
    ring.add(dot);
    ring.position.set(x, this.heightAt(x, z) + 0.25, z);
    ring.renderOrder = 6;
    dot.renderOrder = 6;
    this.group.add(ring);
    this.markers.push({ mesh: ring, age: 0, life: 0.75, kind: 'ring' });
  }

  /** Red brackets that track an attack target for a moment. */
  target(follow: () => THREE.Vector3 | null, radius: number): void {
    const mesh = new THREE.Mesh(this.bracketGeo, this.material(ATTACK_COLOR));
    mesh.scale.setScalar(radius * 1.5);
    mesh.renderOrder = 6;
    this.group.add(mesh);
    this.markers.push({ mesh, age: 0, life: 0.9, kind: 'target', follow });
  }

  /**
   * Indirect fire on its way: a red danger circle of the blast radius with a crosshair, pulsing
   * faster as impact nears. Lasts until the shells land.
   */
  incoming(x: number, z: number, radius: number, seconds: number): void {
    const mat = this.material(ATTACK_COLOR);
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.94, radius, 64).rotateX(-Math.PI / 2), mat);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 48).rotateX(-Math.PI / 2), this.material(ATTACK_COLOR));
    (fill.material as THREE.MeshBasicMaterial).opacity = 0.12;
    ring.add(fill);
    const bar = Math.max(radius * 0.06, 0.25);
    for (const [w, d] of [[radius * 0.5, bar], [bar, radius * 0.5]]) {
      const cross = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat);
      ring.add(cross);
    }
    ring.position.set(x, this.heightAt(x, z) + 0.3, z);
    ring.traverse((o) => (o.renderOrder = 6));
    this.group.add(ring);
    this.markers.push({ mesh: ring, age: 0, life: seconds + 0.25, kind: 'incoming' });
  }

  /** Show/update/hide a factory's rally line. Pass null to hide. */
  rally(factory: number, from: THREE.Vector3 | null, to: THREE.Vector3 | null): void {
    let line = this.rallyLines.get(factory);
    if (!from || !to) {
      if (line) line.visible = false;
      return;
    }
    if (!line) {
      line = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.material(MOVE_COLOR));
      (line.material as THREE.MeshBasicMaterial).opacity = 0.65;
      line.renderOrder = 6;
      const flag = new THREE.Mesh(this.ringGeo, line.material);
      flag.name = 'flag';
      this.group.add(flag);
      line.userData.flag = flag;
      this.rallyLines.set(factory, line);
      this.group.add(line);
    }
    line.visible = true;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    line.position.set((from.x + to.x) / 2, Math.max(this.heightAt((from.x + to.x) / 2, (from.z + to.z) / 2), from.y, to.y) + 0.3, (from.z + to.z) / 2);
    line.rotation.y = Math.atan2(dx, dz);
    line.scale.set(0.35, 1, len);
    const flag = line.userData.flag as THREE.Mesh;
    flag.visible = true;
    flag.position.set(to.x, this.heightAt(to.x, to.z) + 0.25, to.z);
    flag.scale.setScalar(1.6);
  }

  hideRallies(except: Set<number>): void {
    for (const [id, line] of this.rallyLines) {
      if (except.has(id)) continue;
      line.visible = false;
      (line.userData.flag as THREE.Mesh).visible = false;
    }
  }

  update(dt: number, time: number): void {
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.age += dt;
      const t = m.age / m.life;
      const mat = m.mesh.material as THREE.MeshBasicMaterial;
      if (t >= 1) {
        this.group.remove(m.mesh);
        m.mesh.traverse((o) => {
          const mm = o as THREE.Mesh;
          (mm.material as THREE.Material).dispose();
          if (m.kind === 'incoming') mm.geometry.dispose();
        });
        this.markers.splice(i, 1);
        continue;
      }
      if (m.kind === 'incoming') {
        // Pulse speeds up toward impact.
        const left = m.life - m.age;
        const rate = 4 + 18 / Math.max(left, 0.3);
        mat.opacity = 0.55 + 0.45 * Math.sin(m.age * rate);
        continue;
      }
      if (m.kind === 'ring') {
        // Ring collapses onto the point, then fades.
        m.mesh.scale.setScalar(THREE.MathUtils.lerp(3.2, 0.9, Math.min(t * 1.6, 1)));
        mat.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      } else {
        const p = m.follow?.();
        if (p) m.mesh.position.copy(p).setY(p.y + 0.3);
        m.mesh.rotation.y = time * 1.5;
        mat.opacity = (0.6 + 0.4 * Math.sin(m.age * 25)) * (1 - t);
      }
    }
  }
}

/** Four corner brackets around a unit footprint, on the ground plane. */
function buildBracketGeometry(): THREE.BufferGeometry {
  const parts: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number) => {
    parts.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
  };
  const L = 0.45;
  const W = 0.09;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * 1;
      const cz = sz * 1;
      quad(Math.min(cx, cx - sx * L), Math.min(cz, cz - sz * W), Math.max(cx, cx - sx * L), Math.max(cz, cz - sz * W));
      quad(Math.min(cx, cx - sx * W), Math.min(cz, cz - sz * L), Math.max(cx, cx - sx * W), Math.max(cz, cz - sz * L));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(parts, 3));
  return g;
}
