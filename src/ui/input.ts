import type { Command } from '../shared/commands';
import type { EntityState, SimView } from '../shared/entities';
import type { EntityId, PlayerId, Vec2 } from '../shared/types';
import type { Picker } from '../shared/view';
import { defaultKeybinds, type Keybinds } from './keybinds';

const DRAG_PX = 5;
const RIGHT_DRAG_PX = 14;
const DOUBLE_CLICK_MS = 320;
const HOVER_EVERY_MS = 60;

export type CursorState = 'default' | 'select' | 'move' | 'attack' | 'invalid' | 'target' | 'place' | 'rally';

/** Pending targeted order: the next left click on the map completes it. */
export type TargetMode =
  | { kind: 'none' }
  | { kind: 'attackMove' }
  | { kind: 'patrol' }
  | { kind: 'rally'; factories: EntityId[] }
  | { kind: 'place'; structure: string; builder: EntityId; rotation: number }
  /** Aimed ability: click the ground (point abilities) or a unit. */
  | { kind: 'ability'; ability: string; target: 'point' | 'unit'; units: EntityId[] }
  /** Click a transport or building to get in. */
  | { kind: 'enter' }
  /** Click where the selected transports should drop their passengers. */
  | { kind: 'unload' }
  /** Click the superweapon's target. */
  | { kind: 'superweapon' }
  /** Hold the line key and drag to draw a frontline. */
  | { kind: 'line'; reinforce?: number };

export interface InputOptions {
  /** Current key bindings (read on every key press, so rebinding applies live). */
  keybinds?: () => Keybinds;
  /**
   * When false the controller doesn't listen to the keyboard; MatchUi routes keys instead.
   * Defaults to true (Phase 0 Match uses the controller on its own).
   */
  keyboard?: boolean;
  /** Is the entity a structure that takes rally points / is it a builder etc. Optional. */
  isFactory?: (e: EntityState) => boolean;
  /** Validity check for the placement ghost. */
  canPlace?: (structure: string, at: Vec2) => boolean;
  onModeChange?: (mode: TargetMode) => void;
  /** Formation facing preview while right-dragging (screen px), or null when it ends. */
  onFormationDrag?: (from: { x: number; y: number } | null, to?: { x: number; y: number }) => void;
  /** Placement ghost position (screen px + world) every pointer move while placing. */
  onPlacementHover?: (screen: { x: number; y: number } | null, world: Vec2 | null, valid: boolean) => void;
  /** Visible feedback for an issued order (click marker). */
  onOrderMarker?: (screen: { x: number; y: number }, kind: 'move' | 'attack' | 'rally' | 'build') => void;
  /**
   * Attack with a frontline: when the selection holds one line and `at` is in front of it, advance the
   * line there in formation. Returns true if it did (then no move order is sent).
   */
  lineAttack?: (units: EntityId[], at: Vec2) => boolean;
  /** Can these units board/garrison `target`? (Right-click on a transport or building enters it.) */
  canEnter?: (units: EntityId[], target: EntityState) => boolean;
  /** The frontline being drawn (screen points), or null when the stroke ends. */
  onLineStroke?: (points: { x: number; y: number }[] | null) => void;
  /** Whether the local player may order this entity (own, or shared command). Default: owner check. */
  owns?: (e: EntityState) => boolean;
  /** Whether `e` is an enemy (right-click attacks it). Default: anything not owned. */
  hostile?: (e: EntityState) => boolean;
  /** Units "select army" picks (combat units, not engineers or trucks). Default: every unit. */
  isArmy?: (e: EntityState) => boolean;
}

/**
 * Mouse/keyboard → selection + Commands.
 *
 * Left click/drag selects own units (Shift adds/toggles, Ctrl+click or double-click selects all
 * visible units of that type). Right click moves or attacks; right-drag gives the move a facing.
 * Attack-move (Q by default) arms a click, Stop (X), Hold (H); WASD/arrows pan; Ctrl+1..9 set a control group,
 * 1..9 recall it. Targeted orders (attack-move, rally, structure placement) are modes; Esc or
 * right click cancels them.
 */
export class InputController {
  readonly selection = new Set<EntityId>();
  readonly groups = new Map<number, EntityId[]>();
  private dragStart: { x: number; y: number } | null = null;
  private stroke: { x: number; y: number }[] | null = null;
  private rightStart: { x: number; y: number; t: number } | null = null;
  private mode: TargetMode = { kind: 'none' };
  private readonly box: HTMLDivElement;
  private lastClick = { t: 0, id: -1 as EntityId };
  private lastHover = 0;
  private cursor: CursorState = 'default';
  private enabled = true;
  private readonly opts: InputOptions;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly dom: HTMLElement,
    private readonly sim: SimView,
    private readonly picker: Picker,
    readonly localPlayer: PlayerId,
    private readonly issue: (cmd: Command) => void,
    private readonly onSelectionChange: (ids: EntityId[]) => void,
    opts: InputOptions = {},
  ) {
    this.opts = opts;
    this.box = document.createElement('div');
    this.box.className = 'select-box';
    document.body.appendChild(this.box);

    const on = <K extends keyof WindowEventMap>(target: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void) => {
      target.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on(dom, 'contextmenu', (e) => e.preventDefault());
    on(dom, 'pointerdown', (e) => this.onDown(e));
    on(window, 'pointermove', (e) => this.onMove(e));
    on(window, 'pointerup', (e) => this.onUp(e));
    if (opts.keyboard !== false) on(window, 'keydown', (e) => this.onKey(e));
  }

  private get keys(): Keybinds {
    return this.opts.keybinds?.() ?? defaultKeybinds();
  }

  /** Disable while a menu covers the map (pause menu, settings). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.dragStart = null;
      this.rightStart = null;
      this.box.style.display = 'none';
      this.opts.onFormationDrag?.(null);
    }
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.box.remove();
  }

  // --- selection

  private own(ids: Iterable<EntityId>): EntityId[] {
    const out: EntityId[] = [];
    for (const id of ids) {
      const e = this.sim.get(id);
      if (e && this.owns(e)) out.push(id);
    }
    return out;
  }

  owns(e: EntityState): boolean {
    return this.opts.owns ? this.opts.owns(e) : e.owner === this.localPlayer;
  }

  private hostile(e: EntityState): boolean {
    return this.opts.hostile ? this.opts.hostile(e) : !this.owns(e);
  }

  /** Units first: a box over units and buildings selects only the units. */
  private preferUnits(ids: EntityId[]): EntityId[] {
    const units = ids.filter((id) => this.sim.get(id)?.kind === 'unit');
    return units.length ? units : ids.filter((id) => this.sim.get(id)?.kind === 'structure');
  }

  select(ids: EntityId[], additive = false): void {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    if (this.mode.kind !== 'none') this.setMode({ kind: 'none' });
    this.onSelectionChange([...this.selection]);
  }

  deselect(ids: EntityId[]): void {
    for (const id of ids) this.selection.delete(id);
    this.onSelectionChange([...this.selection]);
  }

  /** Own units of `type` currently on screen. */
  visibleOfType(type: string): EntityId[] {
    return this.own(this.picker.entitiesInRect(0, 0, innerWidth, innerHeight)).filter((id) => this.sim.get(id)?.type === type);
  }

  selectArmy(): void {
    const ids: EntityId[] = [];
    for (const e of this.sim.entities()) if (e.kind === 'unit' && !e.inside && this.owns(e) && (!this.opts.isArmy || this.opts.isArmy(e))) ids.push(e.id);
    this.select(ids);
  }

  /** Drop ids that no longer exist (died/removed) or went inside a transport/building. */
  prune(): void {
    let changed = false;
    for (const id of this.selection) {
      const e = this.sim.get(id);
      if (!e || e.inside) changed = this.selection.delete(id) || changed;
    }
    if (changed) this.onSelectionChange([...this.selection]);
    for (const [k, ids] of this.groups) {
      const alive = ids.filter((id) => this.sim.get(id));
      if (alive.length !== ids.length) this.groups.set(k, alive);
    }
  }

  setGroup(n: number, additive = false): void {
    const ids = [...this.selection];
    this.groups.set(n, additive ? [...new Set([...(this.groups.get(n) ?? []), ...ids])] : ids);
  }

  recallGroup(n: number, additive = false): EntityId[] {
    const ids = this.own(this.groups.get(n) ?? []);
    this.select(ids, additive);
    return ids;
  }

  // --- modes

  getMode(): TargetMode {
    return this.mode;
  }

  setMode(m: TargetMode): void {
    this.mode = m;
    this.opts.onModeChange?.(m);
    if (m.kind !== 'place') this.opts.onPlacementHover?.(null, null, false);
    this.refreshCursor();
  }

  armAttackMove(): void {
    if (this.selection.size) this.setMode({ kind: 'attackMove' });
  }

  beginPlacement(structure: string, builder: EntityId): void {
    this.setMode({ kind: 'place', structure, builder, rotation: 0 });
  }

  rotatePlacement(): void {
    if (this.mode.kind === 'place') {
      this.mode = { ...this.mode, rotation: (this.mode.rotation + Math.PI / 2) % (Math.PI * 2) };
      this.opts.onModeChange?.(this.mode);
    }
  }

  cancelMode(): boolean {
    if (this.mode.kind === 'none') return false;
    this.setMode({ kind: 'none' });
    return true;
  }

  stop(): void {
    const units = this.units();
    if (units.length) this.issue({ type: 'stop', units });
  }

  hold(): void {
    const units = this.units();
    if (units.length) this.issue({ type: 'hold', units });
  }

  /** Selected own mobile units (structures can't take move orders). */
  units(): EntityId[] {
    return [...this.selection].filter((id) => {
      const e = this.sim.get(id);
      return !!e && e.kind === 'unit' && this.owns(e);
    });
  }

  private factories(): EntityId[] {
    const isF = this.opts.isFactory;
    return [...this.selection].filter((id) => {
      const e = this.sim.get(id);
      return !!e && e.kind === 'structure' && this.owns(e) && (!isF || isF(e));
    });
  }

  // --- pointer

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.button === 0) {
      if (this.mode.kind === 'line') {
        this.stroke = [{ x: e.clientX, y: e.clientY }];
        this.opts.onLineStroke?.(this.stroke);
        return;
      }
      if (this.mode.kind !== 'none') {
        this.completeMode(e);
        return;
      }
      this.dragStart = { x: e.clientX, y: e.clientY };
    } else if (e.button === 2) {
      if (this.cancelMode()) return;
      this.rightStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    }
  }

  private completeMode(e: PointerEvent): void {
    const m = this.mode;
    const p = this.picker.pickGround(e.clientX, e.clientY);
    const at = { x: e.clientX, y: e.clientY };
    if (m.kind === 'attackMove' || m.kind === 'patrol') {
      const units = this.units();
      if (p && units.length) {
        if (m.kind === 'patrol') this.issue({ type: 'patrol', units, target: p, queue: e.shiftKey });
        else if (!e.shiftKey && this.opts.lineAttack?.(units, p)) {
          // The whole line advanced there in formation.
        } else this.issue({ type: 'move', units, target: p, attackMove: true, queue: e.shiftKey });
        this.opts.onOrderMarker?.(at, 'attack');
      }
      if (!e.shiftKey) this.setMode({ kind: 'none' });
    } else if (m.kind === 'ability') {
      const units = m.units.filter((id) => this.sim.get(id));
      if (m.target === 'unit') {
        const id = this.picker.pickEntity(e.clientX, e.clientY);
        if (id === null) return;
        this.issue({ type: 'useAbility', units, ability: m.ability, targetId: id, queue: e.shiftKey });
      } else if (p) this.issue({ type: 'useAbility', units, ability: m.ability, at: p, queue: e.shiftKey });
      this.opts.onOrderMarker?.(at, 'attack');
      this.setMode({ kind: 'none' });
    } else if (m.kind === 'enter') {
      const id = this.picker.pickEntity(e.clientX, e.clientY);
      const target = id !== null ? this.sim.get(id) : undefined;
      const units = this.units();
      if (target && units.length) {
        this.issue({ type: 'enter', units, target: target.id, queue: e.shiftKey });
        this.opts.onOrderMarker?.(at, 'move');
      }
      this.setMode({ kind: 'none' });
    } else if (m.kind === 'unload') {
      if (p) {
        this.issue({ type: 'unload', units: [...this.selection], at: p, queue: e.shiftKey });
        this.opts.onOrderMarker?.(at, 'move');
      }
      this.setMode({ kind: 'none' });
    } else if (m.kind === 'superweapon') {
      if (p) {
        this.issue({ type: 'superweapon', at: p });
        this.opts.onOrderMarker?.(at, 'attack');
      }
      this.setMode({ kind: 'none' });
    } else if (m.kind === 'rally') {
      if (p) {
        for (const f of m.factories) this.issue({ type: 'setRally', factory: f, at: p });
        this.opts.onOrderMarker?.(at, 'rally');
      }
      this.setMode({ kind: 'none' });
    } else if (m.kind === 'place') {
      if (!p) return;
      const valid = this.opts.canPlace?.(m.structure, p) ?? true;
      if (!valid) return;
      this.issue({ type: 'build', builder: m.builder, structure: m.structure, at: p, rotation: m.rotation, queue: e.shiftKey });
      this.opts.onOrderMarker?.(at, 'build');
      // Shift keeps placing more of the same.
      if (!e.shiftKey) this.setMode({ kind: 'none' });
    }
  }

  private onMove(e: PointerEvent): void {
    if (!this.enabled) return;
    if (this.stroke) {
      const last = this.stroke[this.stroke.length - 1];
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 12) {
        this.stroke.push({ x: e.clientX, y: e.clientY });
        this.opts.onLineStroke?.(this.stroke);
      }
      return;
    }
    const s = this.dragStart;
    if (s) {
      const w = Math.abs(e.clientX - s.x);
      const hgt = Math.abs(e.clientY - s.y);
      if (w >= DRAG_PX || hgt >= DRAG_PX) {
        Object.assign(this.box.style, {
          display: 'block',
          left: `${Math.min(s.x, e.clientX)}px`,
          top: `${Math.min(s.y, e.clientY)}px`,
          width: `${w}px`,
          height: `${hgt}px`,
        });
      }
    }
    const r = this.rightStart;
    if (r && Math.hypot(e.clientX - r.x, e.clientY - r.y) >= RIGHT_DRAG_PX && this.units().length) {
      this.opts.onFormationDrag?.({ x: r.x, y: r.y }, { x: e.clientX, y: e.clientY });
    }
    if (e.target === this.dom) this.hover(e);
    else if (this.mode.kind === 'place') this.opts.onPlacementHover?.(null, null, false);
  }

  private hover(e: PointerEvent): void {
    if (this.mode.kind === 'place') {
      const p = this.picker.pickGround(e.clientX, e.clientY);
      const valid = !!p && (this.opts.canPlace?.(this.mode.structure, p) ?? true);
      this.opts.onPlacementHover?.({ x: e.clientX, y: e.clientY }, p, valid);
      this.setCursor(valid ? 'place' : 'invalid');
      return;
    }
    const now = performance.now();
    if (now - this.lastHover < HOVER_EVERY_MS || this.dragStart) return;
    this.lastHover = now;
    this.refreshCursor(e.clientX, e.clientY);
  }

  private refreshCursor(sx?: number, sy?: number): void {
    const m = this.mode;
    if (m.kind === 'attackMove' || m.kind === 'patrol' || m.kind === 'ability' || m.kind === 'superweapon' || m.kind === 'line') return this.setCursor('target');
    if (m.kind === 'enter' || m.kind === 'unload') return this.setCursor('move');
    if (m.kind === 'rally') return this.setCursor('rally');
    if (m.kind === 'place') return this.setCursor('place');
    if (sx === undefined || sy === undefined) return this.setCursor('default');
    const id = this.picker.pickEntity(sx, sy);
    const ent = id !== null ? this.sim.get(id) : undefined;
    const hasUnits = this.units().length > 0;
    if (ent && this.owns(ent)) return this.setCursor('select');
    if (ent && ent.owner >= 0 && ent.kind !== 'point' && hasUnits && this.hostile(ent)) return this.setCursor('attack');
    if (hasUnits || this.factories().length) return this.setCursor(this.picker.pickGround(sx, sy) ? (hasUnits ? 'move' : 'rally') : 'invalid');
    this.setCursor(ent ? 'select' : 'default');
  }

  private setCursor(c: CursorState): void {
    if (c === this.cursor) return;
    this.dom.classList.remove(`cursor-${this.cursor}`);
    this.cursor = c;
    this.dom.classList.add(`cursor-${c}`);
  }

  /** Finish a frontline stroke: ground points, thinned, sent as holdLine. */
  private finishStroke(): void {
    const pts = this.stroke;
    this.stroke = null;
    this.opts.onLineStroke?.(null);
    const m = this.mode;
    if (!pts || pts.length < 2 || m.kind !== 'line') return;
    const ground: Vec2[] = [];
    for (const p of pts) {
      const g = this.picker.pickGround(p.x, p.y);
      if (g) ground.push(g);
    }
    const units = this.units();
    if (ground.length >= 2 && units.length) this.issue({ type: 'holdLine', units, points: ground, line: m.reinforce });
    this.setMode({ kind: 'none' });
  }

  /** Line key released: drop the line mode (finishing any stroke in progress). */
  endLineMode(): void {
    if (this.stroke) this.finishStroke();
    if (this.mode.kind === 'line') this.setMode({ kind: 'none' });
  }

  /** True while a frontline stroke is being drawn. */
  get drawing(): boolean {
    return this.stroke !== null;
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 0 && this.stroke) {
      this.finishStroke();
      return;
    }
    if (e.button === 2) {
      const r = this.rightStart;
      this.rightStart = null;
      if (!r || !this.enabled) return;
      const dragged = Math.hypot(e.clientX - r.x, e.clientY - r.y) >= RIGHT_DRAG_PX;
      this.opts.onFormationDrag?.(null);
      if (dragged && this.units().length) this.orderFormation(r, e);
      else this.orderAt(r.x, r.y, e.shiftKey);
      return;
    }
    const s = this.dragStart;
    if (e.button !== 0 || !s) return;
    this.dragStart = null;
    this.box.style.display = 'none';
    if (!this.enabled) return;
    let additive = e.shiftKey;
    if (Math.abs(e.clientX - s.x) >= DRAG_PX || Math.abs(e.clientY - s.y) >= DRAG_PX) {
      this.select(this.preferUnits(this.own(this.picker.entitiesInRect(s.x, s.y, e.clientX, e.clientY))), additive);
      return;
    }
    const id = this.picker.pickEntity(e.clientX, e.clientY);
    const ent = id !== null ? this.sim.get(id) : undefined;
    const now = performance.now();
    const isDouble = id !== null && this.lastClick.id === id && now - this.lastClick.t < DOUBLE_CLICK_MS;
    this.lastClick = { t: now, id: id ?? -1 };
    if (!ent || !this.owns(ent)) {
      // Clicking empty ground clears; clicking anything else (enemy, ally, point) inspects it.
      if (!additive) this.select(ent ? [ent.id] : []);
      return;
    }
    // Own entities replace an inspected foreign one.
    if (additive && [...this.selection].some((id) => { const s = this.sim.get(id); return !!s && !this.owns(s); })) additive = false;
    if (e.ctrlKey || e.metaKey || isDouble) {
      this.select(this.visibleOfType(ent.type), additive);
      return;
    }
    if (additive && this.selection.has(ent.id)) this.deselect([ent.id]);
    else this.select([ent.id], additive);
  }

  private orderAt(sx: number, sy: number, queue: boolean): void {
    const units = this.units();
    if (!units.length) {
      // Right click with only factories selected sets their rally point.
      const factories = this.factories();
      const p = this.picker.pickGround(sx, sy);
      if (factories.length && p) {
        for (const f of factories) this.issue({ type: 'setRally', factory: f, at: p });
        this.opts.onOrderMarker?.({ x: sx, y: sy }, 'rally');
      }
      return;
    }
    const targetId = this.picker.pickEntity(sx, sy);
    const target = targetId !== null ? this.sim.get(targetId) : undefined;
    // Right-click on a transport or building that can take the selection: get in.
    if (target && target.kind !== 'point' && !units.includes(target.id) && this.opts.canEnter?.(units, target)) {
      this.issue({ type: 'enter', units, target: target.id, queue });
      this.opts.onOrderMarker?.({ x: sx, y: sy }, 'move');
      return;
    }
    if (target && target.owner >= 0 && target.kind !== 'point' && this.hostile(target)) {
      this.issue({ type: 'attack', units, targetId: target.id, queue });
      this.opts.onOrderMarker?.({ x: sx, y: sy }, 'attack');
      return;
    }
    // Right-click ground in front of a selected frontline: the line attacks there together.
    const ground = !queue ? this.picker.pickGround(sx, sy) : null;
    if (ground && this.opts.lineAttack?.(units, ground)) {
      this.opts.onOrderMarker?.({ x: sx, y: sy }, 'attack');
      return;
    }
    this.orderMove(sx, sy, false, queue);
  }

  private orderMove(sx: number, sy: number, attackMove: boolean, queue: boolean): void {
    const units = this.units();
    const p = this.picker.pickGround(sx, sy);
    if (units.length && p) {
      this.issue({ type: 'move', units, target: p, attackMove, queue });
      this.opts.onOrderMarker?.({ x: sx, y: sy }, attackMove ? 'attack' : 'move');
    }
  }

  /** Right-drag: move to the drag start, lined up facing along the drag. */

  private orderFormation(from: { x: number; y: number }, e: PointerEvent): void {
    const units = this.units();
    const a = this.picker.pickGround(from.x, from.y);
    const b = this.picker.pickGround(e.clientX, e.clientY);
    if (!a || !units.length) return;
    const cmd: Command = { type: 'move', units, target: a, queue: e.shiftKey };
    if (b) Object.assign(cmd, { facing: formationFacing(a, b) });
    this.issue(cmd);
    this.opts.onOrderMarker?.(from, 'move');
  }

  // --- keyboard (stand-alone mode; MatchUi routes keys itself)

  private onKey(e: KeyboardEvent): void {
    if (!this.enabled || isTyping(e)) return;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit) {
      if (e.ctrlKey) {
        this.setGroup(Number(digit), e.shiftKey);
        e.preventDefault();
      } else this.recallGroup(Number(digit), e.shiftKey);
      return;
    }
    const k = this.keys;
    if (e.code === k.attackMove) this.armAttackMove();
    else if (e.code === k.stop) this.stop();
    else if (e.code === k.hold) this.hold();
    else if (e.code === 'Escape') {
      if (!this.cancelMode()) this.select([]);
    }
  }
}

/** Heading (sim convention: 0 faces +z, forward = (sin h, cos h)) from a to b. UI-side floats are fine. */
export function formationFacing(a: Vec2, b: Vec2): number {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
}
