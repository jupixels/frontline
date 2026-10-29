import type { Command } from '../shared/commands';
import type { SimView } from '../shared/entities';
import type { EntityId, PlayerId } from '../shared/types';
import type { Picker } from '../shared/view';

const DRAG_PX = 5;

/**
 * Mouse/keyboard → selection + Commands.
 * Left click/drag selects own units, right click moves (or attacks an enemy), A = attack-move
 * on next left click, S = stop, H = hold, Ctrl+1..9 set control group, 1..9 recall.
 */
export class InputController {
  readonly selection = new Set<EntityId>();
  private groups = new Map<string, EntityId[]>();
  private dragStart: { x: number; y: number } | null = null;
  private attackMoveArmed = false;
  private readonly box: HTMLDivElement;

  constructor(
    private readonly dom: HTMLElement,
    private readonly sim: SimView,
    private readonly picker: Picker,
    private readonly localPlayer: PlayerId,
    private readonly issue: (cmd: Command) => void,
    private readonly onSelectionChange: (ids: EntityId[]) => void,
  ) {
    this.box = document.createElement('div');
    this.box.className = 'select-box';
    document.body.appendChild(this.box);

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', (e) => this.onUp(e));
    addEventListener('keydown', (e) => this.onKey(e));
  }

  private own(ids: Iterable<EntityId>): EntityId[] {
    const out: EntityId[] = [];
    for (const id of ids) if (this.sim.get(id)?.owner === this.localPlayer) out.push(id);
    return out;
  }

  private setSelection(ids: EntityId[], additive = false): void {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.onSelectionChange([...this.selection]);
  }

  /** Drop ids that no longer exist (died/removed). */
  prune(): void {
    let changed = false;
    for (const id of this.selection) if (!this.sim.get(id)) changed = this.selection.delete(id) || changed;
    if (changed) this.onSelectionChange([...this.selection]);
  }

  private onDown(e: PointerEvent): void {
    if (e.button === 0) {
      if (this.attackMoveArmed) {
        this.attackMoveArmed = false;
        this.dom.style.cursor = '';
        this.orderMove(e.clientX, e.clientY, true, e.shiftKey);
        return;
      }
      this.dragStart = { x: e.clientX, y: e.clientY };
    } else if (e.button === 2) {
      this.attackMoveArmed = false;
      this.dom.style.cursor = '';
      this.orderAt(e.clientX, e.clientY, e.shiftKey);
    }
  }

  private onMove(e: PointerEvent): void {
    const s = this.dragStart;
    if (!s) return;
    const w = Math.abs(e.clientX - s.x);
    const h = Math.abs(e.clientY - s.y);
    if (w < DRAG_PX && h < DRAG_PX) return;
    Object.assign(this.box.style, {
      display: 'block',
      left: `${Math.min(s.x, e.clientX)}px`,
      top: `${Math.min(s.y, e.clientY)}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
  }

  private onUp(e: PointerEvent): void {
    const s = this.dragStart;
    if (e.button !== 0 || !s) return;
    this.dragStart = null;
    this.box.style.display = 'none';
    if (Math.abs(e.clientX - s.x) >= DRAG_PX || Math.abs(e.clientY - s.y) >= DRAG_PX) {
      this.setSelection(this.own(this.picker.entitiesInRect(s.x, s.y, e.clientX, e.clientY)), e.shiftKey);
    } else {
      const id = this.picker.pickEntity(e.clientX, e.clientY);
      this.setSelection(id !== null ? this.own([id]) : [], e.shiftKey);
    }
  }

  private orderAt(sx: number, sy: number, queue: boolean): void {
    const units = [...this.selection];
    if (!units.length) return;
    const targetId = this.picker.pickEntity(sx, sy);
    const target = targetId !== null ? this.sim.get(targetId) : undefined;
    if (target && target.owner !== this.localPlayer && target.owner >= 0) {
      this.issue({ type: 'attack', units, targetId: target.id, queue });
      return;
    }
    this.orderMove(sx, sy, false, queue);
  }

  private orderMove(sx: number, sy: number, attackMove: boolean, queue: boolean): void {
    const units = [...this.selection];
    const p = this.picker.pickGround(sx, sy);
    if (units.length && p) this.issue({ type: 'move', units, target: p, attackMove, queue });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const units = [...this.selection];
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit) {
      if (e.ctrlKey) {
        this.groups.set(digit, units);
        e.preventDefault();
      } else {
        this.setSelection(this.own(this.groups.get(digit) ?? []));
      }
      return;
    }
    switch (e.code) {
      case 'KeyA':
        if (units.length) {
          this.attackMoveArmed = true;
          this.dom.style.cursor = 'crosshair';
        }
        break;
      case 'KeyS':
        if (units.length) this.issue({ type: 'stop', units });
        break;
      case 'KeyH':
        if (units.length) this.issue({ type: 'hold', units });
        break;
      case 'Escape':
        this.attackMoveArmed = false;
        this.dom.style.cursor = '';
        this.setSelection([]);
        break;
    }
  }
}
