// Animated "situation map" behind the menus: procedural contour lines, a coordinate grid and a
// slow radar sweep. Purely decorative, so it uses Math.random/Math.sin freely.

function makeNoise(seed: number): (x: number, y: number) => number {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  const N = 64;
  const lattice = new Float32Array(N * N);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const at = (x: number, y: number) => lattice[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * tx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * tx;
    return a + (b - a) * ty;
  };
  return (x, y) => value(x, y) * 0.55 + value(x * 2.1 + 17, y * 2.1 + 9) * 0.3 + value(x * 4.3 + 3, y * 4.3 + 41) * 0.15;
}

interface Blip {
  x: number;
  y: number;
  hostile: boolean;
  seen: number;
}

export class Backdrop {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private contours: HTMLCanvasElement | null = null;
  private raf = 0;
  private sweep = 0;
  private last = 0;
  private blips: Blip[] = [];
  private readonly noise = makeNoise(Math.floor(Math.random() * 1e9));
  private readonly onResize = () => this.layout();

  constructor() {
    this.el = document.createElement('canvas');
    this.el.className = 'backdrop';
    this.ctx = this.el.getContext('2d')!;
    addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.layout());
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private layout(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, this.el.clientWidth || innerWidth);
    const h = Math.max(1, this.el.clientHeight || innerHeight);
    this.el.width = Math.round(w * dpr);
    this.el.height = Math.round(h * dpr);
    this.contours = this.renderContours(this.el.width, this.el.height, dpr);
    this.blips = [];
    for (let i = 0; i < 14; i++) {
      this.blips.push({ x: 0.45 + Math.random() * 0.5, y: 0.1 + Math.random() * 0.8, hostile: Math.random() < 0.45, seen: -10 });
    }
  }

  private renderContours(w: number, h: number, dpr: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    const cell = Math.round(10 * dpr);
    const cols = Math.ceil(w / cell) + 1;
    const rows = Math.ceil(h / cell) + 1;
    const scale = 1 / (260 * dpr);
    const field = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) field[y * cols + x] = this.noise(x * cell * scale, y * cell * scale);

    const levels = 14;
    for (let li = 1; li < levels; li++) {
      const iso = 0.2 + (li / levels) * 0.6;
      const major = li % 4 === 0;
      g.strokeStyle = major ? 'rgba(157, 190, 140, 0.16)' : 'rgba(157, 190, 140, 0.075)';
      g.lineWidth = (major ? 1.3 : 0.8) * dpr;
      g.beginPath();
      // Marching squares, one segment pair per cell.
      for (let y = 0; y < rows - 1; y++) {
        for (let x = 0; x < cols - 1; x++) {
          const a = field[y * cols + x];
          const b = field[y * cols + x + 1];
          const cc = field[(y + 1) * cols + x + 1];
          const d = field[(y + 1) * cols + x];
          const idx = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (cc > iso ? 2 : 0) | (d > iso ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          const px = x * cell;
          const py = y * cell;
          const lerp = (v0: number, v1: number) => (iso - v0) / (v1 - v0 || 1e-6);
          const top: [number, number] = [px + lerp(a, b) * cell, py];
          const right: [number, number] = [px + cell, py + lerp(b, cc) * cell];
          const bottom: [number, number] = [px + lerp(d, cc) * cell, py + cell];
          const left: [number, number] = [px, py + lerp(a, d) * cell];
          const seg = (p: [number, number], q: [number, number]) => {
            g.moveTo(p[0], p[1]);
            g.lineTo(q[0], q[1]);
          };
          switch (idx) {
            case 1: case 14: seg(left, bottom); break;
            case 2: case 13: seg(bottom, right); break;
            case 3: case 12: seg(left, right); break;
            case 4: case 11: seg(top, right); break;
            case 5: seg(left, top); seg(bottom, right); break;
            case 6: case 9: seg(top, bottom); break;
            case 7: case 8: seg(left, top); break;
            case 10: seg(left, bottom); seg(top, right); break;
          }
        }
      }
      g.stroke();
    }

    // Map grid with coordinate labels.
    const grid = Math.round(120 * dpr);
    g.strokeStyle = 'rgba(200, 220, 190, 0.05)';
    g.lineWidth = dpr;
    g.beginPath();
    for (let x = grid; x < w; x += grid) {
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, h);
    }
    for (let y = grid; y < h; y += grid) {
      g.moveTo(0, y + 0.5);
      g.lineTo(w, y + 0.5);
    }
    g.stroke();
    g.fillStyle = 'rgba(200, 220, 190, 0.16)';
    g.font = `${10 * dpr}px Consolas, ui-monospace, monospace`;
    for (let x = grid, i = 0; x < w; x += grid, i++) g.fillText(String.fromCharCode(65 + (i % 26)), x + 4 * dpr, 14 * dpr);
    for (let y = grid, i = 1; y < h; y += grid, i++) g.fillText(String(i).padStart(2, '0'), 4 * dpr, y - 4 * dpr);
    return c;
  }

  private tick(t: number): void {
    this.raf = requestAnimationFrame((tt) => this.tick(tt));
    if (!this.el.isConnected) return;
    const dt = Math.min(0.1, (t - (this.last || t)) / 1000);
    this.last = t;
    const { ctx, el } = this;
    const w = el.width;
    const h = el.height;
    ctx.clearRect(0, 0, w, h);
    if (this.contours) ctx.drawImage(this.contours, 0, 0);

    // Radar centered right of the menu column.
    const cx = w * 0.68;
    const cy = h * 0.52;
    const R = Math.min(w, h) * 0.42;
    this.sweep = (this.sweep + dt * 0.55) % (Math.PI * 2);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(157, 255, 122, 0.10)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, (R * i) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-R, 0);
    ctx.lineTo(R, 0);
    ctx.moveTo(0, -R);
    ctx.lineTo(0, R);
    ctx.stroke();
    // Sweep wedge.
    const grad = ctx.createConicGradient(this.sweep - 0.9, 0, 0);
    grad.addColorStop(0, 'rgba(157, 255, 122, 0)');
    grad.addColorStop(0.14, 'rgba(157, 255, 122, 0.10)');
    grad.addColorStop(0.1433, 'rgba(157, 255, 122, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Blips light up as the sweep passes, then fade.
    const now = t / 1000;
    for (const b of this.blips) {
      const bx = b.x * w;
      const by = b.y * h;
      const dx = bx - cx;
      const dy = by - cy;
      if (dx * dx + dy * dy > R * R) continue;
      let ang = Math.atan2(dy, dx);
      if (ang < 0) ang += Math.PI * 2;
      let diff = this.sweep - ang;
      if (diff < 0) diff += Math.PI * 2;
      if (diff < 0.06) b.seen = now;
      const age = now - b.seen;
      const a = Math.max(0, 1 - age / 4);
      if (a <= 0) continue;
      ctx.fillStyle = b.hostile ? `rgba(230, 95, 75, ${0.75 * a})` : `rgba(157, 255, 122, ${0.75 * a})`;
      const s = 3 * Math.min(devicePixelRatio || 1, 2);
      if (b.hostile) {
        ctx.beginPath();
        ctx.moveTo(bx, by - s * 1.4);
        ctx.lineTo(bx + s * 1.4, by);
        ctx.lineTo(bx, by + s * 1.4);
        ctx.lineTo(bx - s * 1.4, by);
        ctx.closePath();
        ctx.fill();
      } else ctx.fillRect(bx - s, by - s * 0.7, s * 2, s * 1.4);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.el.remove();
  }
}
