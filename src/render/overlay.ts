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
      uniforms: { uViewport: { value: this.viewport } },
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

  begin(): void {
    this.count = 0;
  }

  /** `widthPx` in CSS pixels; `selected` draws a brighter frame. */
  add(pos: THREE.Vector3, fill: number, widthPx: number, selected: boolean): void {
    if (this.count >= MAX_BARS) return;
    const i = this.count++;
    this.aWorld.setXYZ(i, pos.x, pos.y, pos.z);
    this.aData.setXYZW(i, THREE.MathUtils.clamp(fill, 0, 1), widthPx, selected ? 1 : 0, 0);
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
  vec2 sizePx = vec2(aData.y, 5.0);
  clip.xy += position.xy * sizePx / uViewport * 2.0 * clip.w;
  gl_Position = clip;
}
`;

const BAR_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vData;
void main() {
  float fill = vData.x;
  vec3 hpColor = fill > 0.6 ? vec3(0.45, 0.95, 0.35) : fill > 0.3 ? vec3(0.98, 0.8, 0.25) : vec3(0.98, 0.3, 0.2);
  vec3 c = vUv.x < fill ? hpColor : vec3(0.08, 0.09, 0.08);
  // 1px-ish frame.
  vec2 px = fwidth(vUv);
  float edge = step(vUv.x, px.x) + step(1.0 - px.x, vUv.x) + step(vUv.y, px.y) + step(1.0 - px.y, vUv.y);
  c = mix(c, vData.z > 0.5 ? vec3(0.85) : vec3(0.0), clamp(edge, 0.0, 1.0));
  gl_FragColor = vec4(c, 0.92);
}
`;

interface Marker {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  kind: 'ring' | 'target';
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
        mat.dispose();
        this.markers.splice(i, 1);
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
