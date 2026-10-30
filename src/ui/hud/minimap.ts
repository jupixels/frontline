import type { SimView } from '../../shared/entities';
import type { PlayerId, Vec2 } from '../../shared/types';
import type { Picker } from '../../shared/view';
import { h } from '../dom';
import type { SimAdapter } from '../simAdapter';

export interface CameraControl {
  lookAt(x: number, z: number): void;
  readonly target: { readonly x: number; readonly z: number };
}

interface Ping {
  pos: Vec2;
  color: string;
  born: number;
}

const DRAW_EVERY_MS = 66;

/**
 * Canvas minimap: terrain backdrop, capture points, units by team color, the camera's ground
 * footprint and alert pings. Left click/drag moves the camera; right click orders the selection.
 */
export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private pings: Ping[] = [];
  private dragging = false;
  private lastDraw = 0;
  private readonly px: number;

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly picker: Picker,
    private readonly camera: CameraControl,
    private readonly mapSize: number,
    private readonly local: PlayerId,
    private readonly onRightClick: (pos: Vec2, shift: boolean) => void,
    /** Optional pre-rendered top-down terrain from the renderer. TODO(render): provide one. */
    terrainImage?: CanvasImageSource,
  ) {
    const css = 208;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.px = Math.round(css * dpr);
    this.canvas = h('canvas', { class: 'minimap-canvas', width: this.px, height: this.px });
    this.g = this.canvas.getContext('2d')!;
    this.el = h('div', { class: 'hud-panel minimap' }, this.canvas, h('div', { class: 'minimap-scale mono' }, `${(mapSize / 1000).toFixed(1)} km`));
    this.terrain = this.renderTerrain(terrainImage);

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.button === 0) {
        this.dragging = true;
        this.canvas.setPointerCapture(e.pointerId);
        this.lookAtEvent(e);
      } else if (e.button === 2) {
        const p = this.toWorld(e);
        if (p) this.onRightClick(p, e.shiftKey);
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this.lookAtEvent(e);
    });
    const end = () => (this.dragging = false);
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  private toWorld(e: PointerEvent): Vec2 | null {
    const r = this.canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { x: (u - 0.5) * this.mapSize, z: (v - 0.5) * this.mapSize };
  }

  private lookAtEvent(e: PointerEvent): void {
    const p = this.toWorld(e);
    if (p) this.camera.lookAt(p.x, p.z);
  }

  ping(pos: Vec2, color = '#ff5a3c'): void {
    this.pings.push({ pos, color, born: performance.now() });
    if (this.pings.length > 12) this.pings.shift();
  }

  private renderTerrain(img?: CanvasImageSource): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = this.px;
    const g = c.getContext('2d')!;
    const W = this.px;
    if (img) g.drawImage(img, 0, 0, W, W);
    else {
      const bg = g.createRadialGradient(W * 0.5, W * 0.5, W * 0.1, W * 0.5, W * 0.5, W * 0.75);
      bg.addColorStop(0, '#2f3a28');
      bg.addColorStop(1, '#1b2218');
      g.fillStyle = bg;
      g.fillRect(0, 0, W, W);
      // Faint speckle so the flat fallback doesn't read as an empty box.
      for (let i = 0; i < 900; i++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '210,220,180' : '0,0,0'},${0.03 + Math.random() * 0.04})`;
        const s = 1 + Math.random() * 3;
        g.fillRect(Math.random() * W, Math.random() * W, s, s);
      }
    }
    // 100 m grid.
    const cells = Math.max(2, Math.round(this.mapSize / 100));
    g.strokeStyle = 'rgba(220, 235, 210, 0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < cells; i++) {
      const p = Math.round((i / cells) * W) + 0.5;
      g.moveTo(p, 0);
      g.lineTo(p, W);
      g.moveTo(0, p);
      g.lineTo(W, p);
    }
    g.stroke();
    return c;
  }

  private toPx(x: number, z: number): [number, number] {
    return [(x / this.mapSize + 0.5) * this.px, (z / this.mapSize + 0.5) * this.px];
  }

  /** Ground footprint of the view: pick the 4 screen corners (walk down from the top if it's sky). */
  private frustum(): [number, number][] | null {
    const W = innerWidth;
    const H = innerHeight;
    const pickRow = (y0: number, x: number) => {
      for (let y = y0; y < H; y += H * 0.08) {
        const p = this.picker.pickGround(x, y);
        if (p) return p;
      }
      return null;
    };
    const tl = pickRow(0, 0);
    const tr = pickRow(0, W - 1);
    const br = this.picker.pickGround(W - 1, H - 1);
    const bl = this.picker.pickGround(0, H - 1);
    if (!tl || !tr || !br || !bl) return null;
    return [tl, tr, br, bl].map((p) => this.toPx(p.x, p.z));
  }

  update(now = performance.now()): void {
    if (now - this.lastDraw < DRAW_EVERY_MS) return;
    this.lastDraw = now;
    const g = this.g;
    const W = this.px;
    const dpr = W / 208;
    g.clearRect(0, 0, W, W);
    if (this.terrain) g.drawImage(this.terrain, 0, 0);

    // Capture points under everything else.
    for (const p of this.adapter.points()) {
      const [x, y] = this.toPx(p.pos.x, p.pos.z);
      const r = 6 * dpr;
      g.fillStyle = p.owner >= 0 ? this.adapter.colorOf(p.owner) : 'rgba(220, 220, 200, 0.5)';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.fill();
      g.stroke();
      if (p.progress !== undefined && p.capturer !== undefined && Math.abs(p.progress) > 0 && Math.abs(p.progress) < 1) {
        g.strokeStyle = this.adapter.colorOf(p.capturer);
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.arc(x, y, r + 3 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.abs(p.progress));
        g.stroke();
      }
    }

    // Structures as squares, units as dots; own units drawn last so they sit on top.
    const own: [number, number, number][] = [];
    for (const e of this.sim.entities()) {
      if (e.kind === 'projectile' || e.kind === 'point') continue;
      if (!this.adapter.isVisible(e, this.local)) continue;
      const [x, y] = this.toPx(e.pos.x, e.pos.z);
      if (e.owner === this.local && e.kind === 'unit') {
        own.push([x, y, e.id]);
        continue;
      }
      g.fillStyle = this.adapter.colorOf(e.owner);
      if (e.kind === 'structure') {
        const s = 5 * dpr;
        g.fillRect(x - s / 2, y - s / 2, s, s);
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = dpr;
        g.strokeRect(x - s / 2, y - s / 2, s, s);
      } else {
        g.beginPath();
        g.arc(x, y, 1.9 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = this.adapter.colorOf(this.local);
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = dpr * 0.8;
    for (const [x, y] of own) {
      g.beginPath();
      g.arc(x, y, 2.1 * dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // Camera footprint.
    const f = this.frustum();
    g.strokeStyle = 'rgba(235, 245, 225, 0.85)';
    g.lineWidth = 1.2 * dpr;
    g.beginPath();
    if (f) {
      g.moveTo(f[0][0], f[0][1]);
      for (let i = 1; i < 4; i++) g.lineTo(f[i][0], f[i][1]);
      g.closePath();
    } else {
      const [cx, cy] = this.toPx(this.camera.target.x, this.camera.target.z);
      g.rect(cx - 18 * dpr, cy - 12 * dpr, 36 * dpr, 24 * dpr);
    }
    g.stroke();

    // Pings: two expanding rings over 3 s.
    const life = 3000;
    this.pings = this.pings.filter((p) => now - p.born < life);
    for (const p of this.pings) {
      const age = (now - p.born) / life;
      const [x, y] = this.toPx(p.pos.x, p.pos.z);
      for (const off of [0, 0.25]) {
        const a = (age * 2 + off) % 1;
        g.strokeStyle = p.color;
        g.globalAlpha = (1 - a) * (1 - age * 0.6);
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.arc(x, y, (4 + a * 18) * dpr, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }
}
