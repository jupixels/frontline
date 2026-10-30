import type { Picker } from '../shared/view';
import { h } from './dom';
import { icon } from './icons';
import type { InputController } from './input';
import type { CameraControl } from './hud/minimap';

const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE_PX = 12;

/** Whether this device should get touch controls under the "auto" setting. */
export function touchByDefault(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Tablet and phone controls layered over the mouse input. One finger works like the mouse (tap
 * selects, drag box-selects); a long press, or a tap while Order mode is on, gives the right-click
 * order (move / attack / enter / rally). Two fingers pan the camera and pinch to zoom. A side bar
 * holds Order mode, attack-move, select army and deselect.
 */
export class TouchControls {
  readonly el: HTMLElement;
  private readonly touches = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private orderMode = false;
  private gesture: { mid: { x: number; y: number }; dist: number } | null = null;
  private longTimer = 0;
  private readonly orderBtn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly offs: (() => void)[] = [];
  private synthetic = false;

  constructor(
    private readonly canvas: HTMLElement,
    private readonly input: InputController,
    private readonly picker: Picker,
    private readonly camera: CameraControl,
  ) {
    const btn = (ic: Parameters<typeof icon>[0], label: string, fn: () => void) => h('button', { class: 'touch-btn', type: 'button', 'aria-label': label, html: icon(ic), onclick: fn });
    this.orderBtn = btn('move', 'Order mode', () => this.setOrderMode(!this.orderMode));
    this.hint = h('div', { class: 'touch-hint hidden' });
    this.el = h(
      'div',
      { class: 'touch-layer' },
      h(
        'div',
        { class: 'touch-bar' },
        this.orderBtn,
        btn('attackMove', 'Attack-move', () => {
          this.input.armAttackMove();
          this.flash('Tap the map to attack-move');
        }),
        btn('army', 'Select army', () => this.input.selectArmy()),
        btn('cancel', 'Deselect', () => {
          if (!this.input.cancelMode()) this.input.select([]);
        }),
      ),
      this.hint,
    );
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, fn as EventListener, { capture: true });
      this.offs.push(() => canvas.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.up(e));
    on('pointercancel', (e) => this.up(e));
  }

  private setOrderMode(on: boolean): void {
    this.orderMode = on;
    this.orderBtn.classList.toggle('on', on);
    this.flash(on ? 'Order mode: taps move and attack' : 'Select mode: taps select');
  }

  private flash(text: string): void {
    this.hint.textContent = text;
    this.hint.classList.remove('hidden');
    clearTimeout(Number(this.hint.dataset.t));
    this.hint.dataset.t = String(window.setTimeout(() => this.hint.classList.add('hidden'), 1800));
  }

  private down(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || this.synthetic) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    clearTimeout(this.longTimer);
    if (this.touches.size === 2) {
      // Second finger: this is a camera gesture, not a selection drag.
      this.input.setEnabled(false);
      this.input.setEnabled(true);
      this.gesture = this.measure();
      e.stopImmediatePropagation();
      return;
    }
    if (this.touches.size > 2) return e.stopImmediatePropagation();
    if (this.orderMode && !this.input.getMode().kind.match(/attackMove|patrol|place|ability|enter|unload|rally|superweapon|line/)) {
      // Order mode: the tap becomes a right click (handled on release).
      e.stopImmediatePropagation();
      return;
    }
    const id = e.pointerId;
    this.longTimer = window.setTimeout(() => {
      const t = this.touches.get(id);
      if (!t || Math.hypot(t.x - t.x0, t.y - t.y0) > MOVE_TOLERANCE_PX || this.touches.size !== 1) return;
      // Long press = right click. Cancel the pending left click first.
      this.input.setEnabled(false);
      this.input.setEnabled(true);
      this.rightClick(t.x, t.y);
      this.touches.delete(id);
      if (navigator.vibrate) navigator.vibrate(12);
    }, LONG_PRESS_MS);
  }

  private move(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || this.synthetic) return;
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.gesture && this.touches.size >= 2) {
      e.stopImmediatePropagation();
      const g = this.measure();
      if (!g) return;
      // Pan: keep the ground under the fingers' midpoint.
      const a = this.picker.pickGround(this.gesture.mid.x, this.gesture.mid.y);
      const b = this.picker.pickGround(g.mid.x, g.mid.y);
      if (a && b) this.camera.lookAt(this.camera.target.x + (a.x - b.x), this.camera.target.z + (a.z - b.z));
      // Pinch: the camera zooms on wheel events.
      if (this.gesture.dist > 0 && g.dist > 0) {
        const ratio = g.dist / this.gesture.dist;
        if (Math.abs(Math.log(ratio)) > 0.01) this.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -Math.log(ratio) * 1000, clientX: g.mid.x, clientY: g.mid.y, cancelable: true }));
      }
      this.gesture = g;
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || this.synthetic) return;
    clearTimeout(this.longTimer);
    const t = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (this.gesture) {
      e.stopImmediatePropagation();
      if (this.touches.size < 2) this.gesture = null;
      return;
    }
    if (t && this.orderMode && performance.now() - t.t0 < 600 && Math.hypot(t.x - t.x0, t.y - t.y0) < MOVE_TOLERANCE_PX && !this.input.getMode().kind.match(/attackMove|patrol|place|ability|enter|unload|rally|superweapon|line/)) {
      e.stopImmediatePropagation();
      this.rightClick(t.x, t.y);
    }
  }

  /** Drive the mouse input's right-click path (move / attack / enter / rally). */
  private rightClick(x: number, y: number): void {
    this.synthetic = true;
    const init = { clientX: x, clientY: y, button: 2, buttons: 2, pointerType: 'mouse', bubbles: true, cancelable: true };
    this.canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointerup', init));
    this.synthetic = false;
  }

  private measure(): { mid: { x: number; y: number }; dist: number } | null {
    const pts = [...this.touches.values()].slice(0, 2);
    if (pts.length < 2) return null;
    return { mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) };
  }

  dispose(): void {
    clearTimeout(this.longTimer);
    for (const off of this.offs) off();
    this.el.remove();
  }
}
