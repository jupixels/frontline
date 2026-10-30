import type { Command } from '../../shared/commands';
import type { MapDef, UnitDef } from '../../shared/data';
import type { SimView } from '../../shared/entities';
import type { SimEvent } from '../../shared/events';
import { SIM_HZ, type EntityId, type MatchSetup, type PlayerId, type TeamId, type Vec2 } from '../../shared/types';
import type { Picker } from '../../shared/view';
import { h } from '../dom';
import { InputController, isTyping, type TargetMode } from '../input';
import { GROUP_ACTIONS, keyLabel } from '../keybinds';
import { tooltip } from '../tooltip';
import { TouchControls, touchByDefault } from '../touch';
import { isLocalMode, type MatchMode } from '../lobbyApi';
import type { MatchResult } from '../screens/results';
import type { SettingsStore } from '../settings';
import { SimAdapter, type StructureInfo } from '../simAdapter';
import { AlertFeed, type Alert } from './alerts';
import { CommandCard } from './commandCard';
import { GroupBar } from './groups';
import { Minimap, type CameraControl } from './minimap';
import { DesyncOverlay, FieldManual, GameMenu, PauseOverlay, StrikeWarning, WaitingOverlay, outcomeBanner } from './overlays';
import { ProductionTray } from './production';
import { ReplayBar, type ReplayControls } from './replayBar';
import { SelectionPanel } from './selection';
import { StatsTracker } from './stats';
import { TopBar } from './topbar';

export type { CameraControl } from './minimap';

/** Optional renderer hooks. Without them the UI draws 2D stand-ins. TODO(render): implement. */
export interface RenderHooks {
  /** 3D structure ghost at a world position, or hide it with null. */
  setPlacementGhost?(ghost: { structure: string; at: Vec2; rotation: number; valid: boolean } | null): void;
  /** Ground marker where an order was issued. */
  showOrderMarker?(at: Vec2, kind: 'move' | 'attack' | 'rally' | 'build'): void;
  /** Top-down terrain image for the minimap. */
  minimapImage?: CanvasImageSource;
}

export interface NetStatus {
  /** Names of players the lockstep is waiting on. Empty = running. */
  waitingFor?: string[];
  /** Set once a desync is detected. */
  desyncTick?: number | null;
  pingMs?: number;
}

export interface MatchUiContext {
  /** HUD container (the #ui element). */
  root: HTMLElement;
  /** Element that receives map clicks (the game canvas). */
  canvas: HTMLElement;
  sim: SimView;
  picker: Picker;
  camera: CameraControl;
  setup: MatchSetup;
  localPlayer: PlayerId;
  units: Record<string, UnitDef>;
  map: MapDef;
  mode: MatchMode;
  settings: SettingsStore;
  issue(cmd: Command): void;
  structures?: Record<string, StructureInfo>;
  render?: RenderHooks;
  onSelectionChange?(ids: EntityId[]): void;
  /** Skirmish only: stop/resume stepping the sim while the menu is open. */
  onPauseChange?(paused: boolean): void;
  /** Player chose Quit to menu (or acknowledged a desync). Tear the match down. */
  onQuit?(): void;
  /** The match ended (victory event or surrender); show results. */
  onMatchEnd?(result: MatchResult): void;
  /** Open the settings screen over the match. */
  openSettings?(): void;
  /** Desync report download, if net can produce one. */
  onDesyncReport?(): void;
  /** Skirmish/replay game speed hotkeys: +1 faster, -1 slower. */
  onSpeedStep?(dir: 1 | -1): void;
  /** Replay transport (mode 'replay'). */
  replay?: ReplayControls;
}

const ATTACK_ALERT_COOLDOWN_MS = 12000;

const BLOCK_TEXT: Record<'supply' | 'cp' | 'requirements' | 'placement' | 'queueFull' | 'demolishHq', string> = {
  supply: 'Not enough supply',
  cp: 'Command point cap reached: hold more points to field more units',
  requirements: 'Requirements not met',
  placement: "Can't build there",
  queueFull: 'Production queue is full',
  demolishHq: "The HQ can't be demolished",
};
const ATTACK_ALERT_CELL = 80;

/**
 * The whole in-match UI: top bar, minimap, selection panel, command card, control groups,
 * alerts, overlays, pause menu, plus the InputController. The match loop calls
 * `handleEvents` after each sim step and `frame` once per rendered frame.
 */
export class MatchUi {
  readonly input: InputController;
  readonly adapter: SimAdapter;
  private readonly el: HTMLElement;
  private readonly fx: HTMLElement;
  private readonly topbar: TopBar;
  private readonly minimap: Minimap;
  private readonly selection: SelectionPanel;
  private readonly card: CommandCard;
  private readonly groups: GroupBar;
  private readonly alerts: AlertFeed;
  private readonly production: ProductionTray;
  private readonly manual: FieldManual;
  private idleCursor = 0;
  private readonly replayBar: ReplayBar | null = null;
  private touch: TouchControls | null = null;
  private readonly waiting = new WaitingOverlay();
  private readonly pauseOverlay: PauseOverlay;
  private readonly strike = new StrikeWarning();
  private readonly stroke: SVGSVGElement;
  /** The frontline key is held; released without drawing it recenters (old binding). */
  private lineKeyDown = false;
  private readonly lastBlock = new Map<string, number>();
  private readonly lastProduced = new Map<string, number>();
  private lineDrawn = false;
  private readonly desync: DesyncOverlay;
  private readonly menu: GameMenu;
  private readonly stats: StatsTracker;
  private readonly ghost: HTMLElement;
  private readonly arrow: SVGSVGElement;
  private readonly attackAlerts = new Map<string, number>();
  private readonly lastGroupTap = { n: 0, t: 0 };
  private net: NetStatus = {};
  private ended = false;
  private blocked = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly ctx: MatchUiContext) {
    const { sim, setup, localPlayer } = ctx;
    this.adapter = new SimAdapter(sim, setup, ctx.units, ctx.structures);
    this.stats = new StatsTracker(sim, setup, this.adapter, localPlayer);

    const a = this.adapter;
    this.input = new InputController(ctx.canvas, sim, ctx.picker, localPlayer, (cmd) => ctx.issue(cmd), (ids) => this.onSelection(ids), {
      keyboard: false,
      owns: (e) => ctx.mode !== 'replay' && a.canOrder(localPlayer, e),
      hostile: (e) => e.owner >= 0 && !a.isAlly(e.owner, localPlayer),
      isArmy: (e) => !a.isBuilder(e) && !(a.unitDef(e.type) as { logistics?: boolean } | undefined)?.logistics && e.type !== 'supply_truck',
      keybinds: () => ctx.settings.get().keybinds,
      isFactory: (e) => this.adapter.producible(e).length > 0,
      canPlace: (s, at) => {
        const m = this.input?.getMode();
        return this.adapter.canPlace(s, at, ctx.map.size, localPlayer, m?.kind === 'place' ? m.rotation : 0);
      },
      canEnter: (units, target) => this.adapter.canEnter(units, target),
      onLineStroke: (pts) => this.drawStroke(pts),
      onModeChange: (m) => this.onMode(m),
      onFormationDrag: (a, b) => this.drawArrow(a, b),
      onPlacementHover: (s, w, valid) => this.drawGhost(s, w, valid),
      onOrderMarker: (s, kind) => this.marker(s, kind),
    });

    const keys = () => ctx.settings.get().keybinds;
    this.topbar = new TopBar(this.adapter, localPlayer, {
      menu: () => this.openMenu(),
      help: () => this.openManual(),
      jump: (p) => ctx.camera.lookAt(p.x, p.z),
      menuKey: () => keyLabel(keys().menu),
    });
    this.production = new ProductionTray(sim, this.adapter, localPlayer, {
      select: (id, center) => {
        this.input.select([id]);
        if (center) this.centerOn([id]);
      },
      superweapon: () => {
        const army = a.armyOf(localPlayer);
        const site = [...sim.entities()].find((e) => e.owner === army && a.structures[e.type]?.superweapon);
        if (site) this.input.select([site.id]);
        if (a.superweapon(army)?.ready) this.input.setMode({ kind: 'superweapon' });
      },
    });
    this.manual = new FieldManual(() => ({ keys: Object.fromEntries(Object.entries(keys()).map(([k2, v]) => [k2, keyLabel(v)])) }), () => this.closeManual());
    this.minimap = new Minimap(sim, this.adapter, ctx.picker, ctx.camera, ctx.map.size, localPlayer, (p, shift) => this.minimapOrder(p, shift), ctx.render?.minimapImage);
    this.selection = new SelectionPanel(sim, this.adapter, this.input, ctx.issue, () => ({ select: keyLabel(keys().selectArmy), group: keyLabel(keys().idleEngineer) }));
    this.card = new CommandCard(sim, this.adapter, this.input, localPlayer, ctx.issue, keys, (msg) => this.alert({ kind: 'warn', text: msg }));
    this.groups = new GroupBar(sim, this.adapter, this.input, keys, () => this.quickCounts(), {
      army: () => this.input.selectArmy(),
      idle: () => this.nextIdleEngineer(),
      recall: (n, add, center) => this.recallGroup(n, add, center),
    });
    this.alerts = new AlertFeed((p) => ctx.camera.lookAt(p.x, p.z), () => keyLabel(keys().jumpAlert));
    this.desync = new DesyncOverlay(() => ctx.onQuit?.(), ctx.onDesyncReport);
    this.pauseOverlay = new PauseOverlay((paused) => ctx.issue({ type: 'pauseVote', paused }));
    this.menu = new GameMenu(ctx.mode, {
      resume: () => this.closeMenu(),
      settings: () => ctx.openSettings?.(),
      surrender: () => {
        ctx.issue({ type: 'surrender' });
        this.closeMenu();
      },
      quit: () => {
        if (ctx.mode === 'online') ctx.issue({ type: 'surrender' });
        this.closeMenu();
        ctx.onQuit?.();
      },
      pauseVote: () => {
        ctx.issue({ type: 'pauseVote', paused: true });
        this.closeMenu();
      },
    });

    if (ctx.mode === 'replay' && ctx.replay) this.replayBar = new ReplayBar(ctx.replay, setup, keys);

    this.ghost = h('div', { class: 'place-ghost hidden' }, h('span', { class: 'ghost-label mono' }));
    this.arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrow.setAttribute('class', 'formation-arrow hidden');
    this.arrow.innerHTML =
      '<defs><marker id="fl-arrowhead" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs><line marker-end="url(#fl-arrowhead)"/><circle r="5"/>';
    this.stroke = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.stroke.setAttribute('class', 'line-stroke hidden');
    this.stroke.innerHTML = '<polyline points=""/>';
    this.fx = h('div', { class: 'hud-fx' }, this.ghost, this.arrow, this.stroke);

    this.el = h(
      'div',
      { class: 'hud' },
      this.fx,
      this.topbar.el,
      h('div', { class: 'hud-left' }, this.production.el),
      h('div', { class: 'hud-alerts' }, this.alerts.el),
      h('div', { class: 'hud-bottom' }, this.minimap.el, h('div', { class: 'hud-center' }, this.replayBar?.el, this.groups.el, this.selection.el), this.card.el),
      this.waiting.el,
      this.pauseOverlay.el,
      this.strike.el,
      this.menu.el,
      this.manual.el,
      this.desync.el,
    );
    this.el.classList.add(`mode-${ctx.mode}`);
    ctx.root.appendChild(this.el);
    this.applySettings();
    this.cleanup.push(ctx.settings.subscribe(() => this.applySettings()));

    const onKey = (e: KeyboardEvent) => this.onKey(e);
    addEventListener('keydown', onKey);
    this.cleanup.push(() => removeEventListener('keydown', onKey));
    const onKeyUp = (e: KeyboardEvent) => this.onKeyUp(e);
    addEventListener('keyup', onKeyUp);
    this.cleanup.push(() => removeEventListener('keyup', onKeyUp));

    this.selection.update(performance.now(), true);
    this.card.update(performance.now(), true);
    this.alert({ kind: 'info', text: ctx.mode === 'tutorial' ? 'Basic training: follow the card on the right' : ctx.mode === 'replay' ? `Replay: ${ctx.map.name}` : `${ctx.map.name}: ${setup.victory === 'frontline' ? 'hold the strategic points' : 'destroy all enemy production'}` });
  }

  private applySettings(): void {
    const s = this.ctx.settings.get();
    const wantTouch = s.touch === 'on' || (s.touch === 'auto' && touchByDefault());
    if (wantTouch && !this.touch) {
      this.touch = new TouchControls(this.ctx.canvas, this.input, this.ctx.picker, this.ctx.camera);
      this.el.appendChild(this.touch.el);
    } else if (!wantTouch && this.touch) {
      this.touch.dispose();
      this.touch = null;
    }
    this.el.classList.toggle('touch', wantTouch);
    // TODO(render): RtsCamera has a fixed PAN_SPEED; expose `panSpeed` so this setting applies.
    const cam = this.ctx.camera as CameraControl & { panSpeed?: number };
    if ('panSpeed' in cam) cam.panSpeed = s.edgePanSpeed;
  }

  // --- selection & modes

  private onSelection(ids: EntityId[]): void {
    this.ctx.onSelectionChange?.(ids);
    this.card.selectionChanged();
    this.selection.update(performance.now(), true);
    this.groups.update(performance.now(), true);
  }

  private onMode(m: TargetMode): void {
    this.el.classList.toggle('placing', m.kind === 'place');
    if (m.kind !== 'place') {
      this.ghost.classList.add('hidden');
      this.ctx.render?.setPlacementGhost?.(null);
    }
    this.card.update(performance.now(), true);
  }

  private recallGroup(n: number, additive: boolean, center: boolean): void {
    const ids = this.input.recallGroup(n, additive);
    if (center) this.centerOn(ids);
  }

  private centerOn(ids: Iterable<EntityId>): void {
    let x = 0;
    let z = 0;
    let n = 0;
    for (const id of ids) {
      const e = this.ctx.sim.get(id);
      if (!e) continue;
      x += e.pos.x;
      z += e.pos.z;
      n++;
    }
    if (n) this.ctx.camera.lookAt(x / n, z / n);
  }

  private minimapOrder(p: Vec2, shift: boolean): void {
    const units = this.input.units();
    if (units.length) {
      this.ctx.issue({ type: 'move', units, target: p, queue: shift });
      this.minimap.ping(p, '#9dff7a');
    }
  }

  // --- keyboard

  private onKey(e: KeyboardEvent): void {
    if (this.blocked || this.ended || isTyping(e) || e.repeat) return;
    if (this.desync.visible) return;
    const k = this.ctx.settings.get().keybinds;
    const code = e.code;
    if (this.menu.visible) {
      if (code === 'Escape' || code === k.menu) {
        e.preventDefault();
        this.closeMenu();
      }
      return;
    }
    if (this.manual.visible) {
      if (code === 'Escape' || code === k.fieldManual) {
        e.preventDefault();
        this.closeManual();
      }
      return;
    }

    const groupIdx = GROUP_ACTIONS.findIndex((g) => k[g] === code);
    if (groupIdx >= 0 && !e.altKey) {
      const n = groupIdx + 1;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.input.setGroup(n, e.shiftKey);
        this.groups.update(performance.now(), true);
        return;
      }
      const now = performance.now();
      const twice = this.lastGroupTap.n === n && now - this.lastGroupTap.t < 400;
      this.lastGroupTap.n = n;
      this.lastGroupTap.t = now;
      this.recallGroup(n, e.shiftKey, twice);
      return;
    }

    if (this.input.getMode().kind === 'place' && code === k.rotateStructure) {
      this.input.rotatePlacement();
      return;
    }
    // Hold the frontline key and drag to draw a line for the selected units.
    if (code === k.drawLine && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this.lineKeyDown = true;
      this.lineDrawn = false;
      if (this.input.units().length) {
        const lines = [...new Set(this.input.units().map((id) => this.ctx.sim.get(id)?.line ?? 0))];
        this.input.setMode({ kind: 'line', reinforce: e.shiftKey && lines.length === 1 && lines[0] ? lines[0] : undefined });
      }
      return;
    }
    if (code === 'Escape') {
      e.preventDefault();
      if (this.input.cancelMode() || this.card.back()) return;
      if (this.input.selection.size) this.input.select([]);
      else this.openMenu();
      return;
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && this.card.handleKey(code, e.shiftKey)) {
      e.preventDefault();
      return;
    }
    if (code === k.menu) {
      e.preventDefault();
      this.openMenu();
    } else if (code === k.fieldManual) {
      e.preventDefault();
      this.openManual();
    } else if (code === k.idleEngineer) {
      e.preventDefault();
      this.nextIdleEngineer();
    } else if (code === k.jumpBase) {
      e.preventDefault();
      this.jumpBase();
    } else if (code === k.gameSpeedUp || code === k.gameSpeedDown) {
      e.preventDefault();
      this.ctx.onSpeedStep?.(code === k.gameSpeedUp ? 1 : -1);
    } else if (code === k.jumpAlert && this.replayBar) {
      e.preventDefault();
      this.replayBar.toggle();
    } else if (code === k.jumpAlert) {
      e.preventDefault();
      this.alerts.jump();
    } else if (code === k.centerSelection) {
      this.centerOn(this.input.selection);
    } else if (code === k.selectArmy) {
      e.preventDefault();
      this.input.selectArmy();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const k = this.ctx.settings.get().keybinds;
    if (e.code !== k.drawLine || !this.lineKeyDown) return;
    this.lineKeyDown = false;
    const drew = this.lineDrawn || this.input.drawing;
    this.input.endLineMode();
    // Tapped without drawing: the old "center on selection" binding still works.
    if (!drew && k.centerSelection === k.drawLine) this.centerOn(this.input.selection);
  }

  private drawStroke(pts: { x: number; y: number }[] | null): void {
    const poly = this.stroke.querySelector('polyline')!;
    if (!pts) {
      this.stroke.classList.add('hidden');
      return;
    }
    this.lineDrawn = true;
    poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    this.stroke.classList.remove('hidden');
  }

  /** Add an element (tutorial panel, ...) to the HUD layer. */
  mount(el: HTMLElement): void {
    this.el.appendChild(el);
  }

  /** Flash a spot on the minimap. */
  ping(pos: Vec2, color = '#9dff7a'): void {
    this.minimap.ping(pos, color);
  }

  /** The current keybinds as short labels, e.g. { attackMove: 'Q' }. */
  keyLabels(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.ctx.settings.get().keybinds).map(([k, v]) => [k, keyLabel(v)]));
  }

  /** Brief note when the game speed changes. */
  toastSpeed(speed: number): void {
    this.alert({ kind: 'info', text: `Game speed ${speed}×` });
  }

  private quickCounts(): { army: number; idleEngineers: number } {
    let army = 0;
    let idle = 0;
    const a = this.adapter;
    const me = this.ctx.localPlayer;
    for (const e of this.ctx.sim.entities()) {
      if (e.kind !== 'unit' || e.inside || !a.canOrder(me, e)) continue;
      if (a.isBuilder(e)) {
        if (!e.moving && !this.busyEngineers.has(e.id)) idle++;
      } else if (e.type !== 'supply_truck') army++;
    }
    return { army, idleEngineers: idle };
  }

  /** Engineers that were given a build order recently count as busy even while standing. */
  private readonly busyEngineers = new Set<EntityId>();
  private readonly buildSites = new Map<EntityId, EntityId>();

  private nextIdleEngineer(): void {
    const a = this.adapter;
    const me = this.ctx.localPlayer;
    const idle = [...this.ctx.sim.entities()].filter((e) => e.kind === 'unit' && !e.inside && a.canOrder(me, e) && a.isBuilder(e) && !e.moving && !this.busyEngineers.has(e.id));
    if (!idle.length) return;
    const e = idle[this.idleCursor++ % idle.length];
    this.input.select([e.id]);
    this.ctx.camera.lookAt(e.pos.x, e.pos.z);
  }

  private jumpBase(): void {
    const army = this.adapter.armyOf(this.ctx.localPlayer);
    const hq = [...this.ctx.sim.entities()].find((e) => e.owner === army && e.type === 'hq');
    if (hq) this.ctx.camera.lookAt(hq.pos.x, hq.pos.z);
  }

  private openManual(): void {
    if (this.ended) return;
    tooltip.hide();
    this.manual.show();
    this.input.setEnabled(false);
  }

  private closeManual(): void {
    this.manual.hide();
    this.input.setEnabled(!this.blocked && !this.menu.visible);
  }

  private openMenu(): void {
    tooltip.hide();
    if (this.ended) return;
    this.input.cancelMode();
    this.menu.show();
    this.input.setEnabled(false);
    if (isLocalMode(this.ctx.mode)) this.ctx.onPauseChange?.(true);
  }

  private closeMenu(): void {
    this.menu.hide();
    this.input.setEnabled(true);
    if (isLocalMode(this.ctx.mode)) this.ctx.onPauseChange?.(false);
  }

  /** UiApp blocks HUD hotkeys while a screen (settings) is open on top of the match. */
  setBlocked(b: boolean): void {
    this.blocked = b;
    this.input.setEnabled(!b && !this.menu.visible);
  }

  // --- fx (2D stand-ins until render hooks exist)

  private drawGhost(screen: { x: number; y: number } | null, world: Vec2 | null, valid: boolean): void {
    const m = this.input.getMode();
    if (m.kind !== 'place' || !screen || !world) {
      this.ghost.classList.add('hidden');
      this.ctx.render?.setPlacementGhost?.(null);
      return;
    }
    const s = this.adapter.structures[m.structure];
    if (this.ctx.render?.setPlacementGhost) {
      this.ctx.render.setPlacementGhost({ structure: m.structure, at: world, rotation: m.rotation, valid });
      this.ghost.classList.add('hidden');
      return;
    }
    // Meters per pixel near the cursor, from a second pick 40 px to the right.
    const side = this.ctx.picker.pickGround(screen.x + 40, screen.y);
    const mpp = side ? Math.hypot(side.x - world.x, side.z - world.z) / 40 : 0.5;
    const sizePx = Math.max(16, ((s?.footprint ?? 8) * 2) / Math.max(mpp, 0.01));
    Object.assign(this.ghost.style, {
      left: `${screen.x}px`,
      top: `${screen.y}px`,
      width: `${sizePx}px`,
      height: `${sizePx * 0.62}px`,
      transform: `translate(-50%, -50%) rotate(${(m.rotation * 180) / Math.PI}deg)`,
    });
    this.ghost.classList.toggle('invalid', !valid);
    this.ghost.classList.remove('hidden');
    (this.ghost.firstElementChild as HTMLElement).textContent = `${s?.name ?? m.structure}${valid ? '' : ' — blocked'}`;
  }

  private drawArrow(a: { x: number; y: number } | null, b?: { x: number; y: number }): void {
    if (!a || !b) {
      this.arrow.classList.add('hidden');
      return;
    }
    const line = this.arrow.querySelector('line')!;
    const dot = this.arrow.querySelector('circle')!;
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    dot.setAttribute('cx', String(a.x));
    dot.setAttribute('cy', String(a.y));
    this.arrow.classList.remove('hidden');
  }

  private marker(screen: { x: number; y: number }, kind: 'move' | 'attack' | 'rally' | 'build'): void {
    const world = this.ctx.picker.pickGround(screen.x, screen.y);
    if (world && this.ctx.render?.showOrderMarker) {
      this.ctx.render.showOrderMarker(world, kind);
      return;
    }
    const m = h('div', { class: `order-marker ${kind}`, style: { left: `${screen.x}px`, top: `${screen.y}px` } });
    this.fx.appendChild(m);
    setTimeout(() => m.remove(), 650);
  }

  // --- alerts

  private alert(a: Alert): void {
    this.alerts.push(a);
    if (a.pos && (a.kind === 'attack' || a.kind === 'lost')) this.minimap.ping(a.pos, '#ef5d48');
    else if (a.pos && a.kind === 'capture') this.minimap.ping(a.pos, '#9dff7a');
  }

  private attackAlert(at: Vec2, structure: boolean): void {
    const cell = `${Math.floor(at.x / ATTACK_ALERT_CELL)},${Math.floor(at.z / ATTACK_ALERT_CELL)}`;
    const now = performance.now();
    if (now - (this.attackAlerts.get(cell) ?? -Infinity) < ATTACK_ALERT_COOLDOWN_MS) return;
    this.attackAlerts.set(cell, now);
    this.alert({ kind: 'attack', text: structure ? 'Base under attack' : 'Units under attack', pos: at });
  }

  /** Feed each step's events (after `sim.step`). */
  handleEvents(events: SimEvent[]): void {
    this.stats.handle(events);
    const a = this.adapter;
    // Alerts follow the army we play (ours, or the shared one in co-op).
    const me = a.armyOf(this.ctx.localPlayer);
    const isMe = (p: PlayerId) => p === me || p === this.ctx.localPlayer;
    for (const ev of events) {
      switch (ev.type) {
        case 'underAttack':
          if (isMe(ev.player)) this.attackAlert(ev.at, true);
          break;
        case 'hit': {
          const v = this.stats.info(ev.id);
          const by = ev.by !== undefined ? this.stats.info(ev.by) : undefined;
          if (v?.owner === me && (!by || !a.isAlly(by.owner, me))) this.attackAlert(ev.at, v.kind === 'structure');
          break;
        }
        case 'captured': {
          const pos = this.ctx.sim.get(ev.point)?.pos;
          if (ev.by === me) this.alert({ kind: 'capture', text: 'Point captured', pos });
          else if (a.isAlly(ev.by, me)) this.alert({ kind: 'capture', text: `${a.slot(ev.by)?.name ?? 'Ally'} captured a point`, pos });
          else this.alert({ kind: 'lost', text: 'Enemy captured a point', pos });
          break;
        }
        case 'placed':
          this.buildSites.set(ev.id, ev.builder);
          this.busyEngineers.add(ev.builder);
          break;
        case 'ordered':
          if (ev.order === 'build') for (const u of ev.units) this.busyEngineers.add(u);
          else for (const u of ev.units) this.busyEngineers.delete(u);
          break;
        case 'removed': {
          const b = this.buildSites.get(ev.id);
          if (b !== undefined) this.busyEngineers.delete(b);
          this.buildSites.delete(ev.id);
          break;
        }
        case 'demolish': {
          // Our own demolitions only (it isn't a loss, so no "destroyed" alert).
          if (ev.state !== 'done' || this.stats.info(ev.id)?.owner !== me) break;
          const what = this.stats.info(ev.id)?.type;
          this.alert({ kind: 'info', text: `${what ? a.displayName(what) : 'Building'} demolished: +${ev.refund} supply`, pos: ev.at });
          break;
        }
        case 'built': {
          const b = this.buildSites.get(ev.id);
          if (b !== undefined) this.busyEngineers.delete(b);
          this.buildSites.delete(ev.id);
          const e = this.ctx.sim.get(ev.id);
          if (e?.owner === me) this.alert({ kind: 'ready', text: `Construction complete: ${a.displayName(e.type)}`, pos: e.pos });
          break;
        }
        case 'produced': {
          const f = this.ctx.sim.get(ev.factory);
          const u = this.ctx.sim.get(ev.unit);
          // A squad arrives as several soldiers: one alert per squad.
          const key = `${ev.factory}:${u?.type}`;
          const now = performance.now();
          if (f?.owner === me && u && now - (this.lastProduced.get(key) ?? -1e9) > 1500) {
            this.lastProduced.set(key, now);
            this.alert({ kind: 'ready', text: `${a.displayName(u.type)} ready`, pos: u.pos });
          }
          break;
        }
        case 'died': {
          const v = this.stats.info(ev.id);
          if (v?.owner === me && v.kind === 'structure') this.alert({ kind: 'lost', text: `${a.displayName(v.type)} destroyed`, pos: this.ctx.sim.get(ev.id)?.pos });
          break;
        }
        case 'promoted': {
          const u = this.ctx.sim.get(ev.id);
          if (u?.owner === me) this.alert({ kind: 'ready', text: `${a.displayName(u.type)} promoted to ${['', 'Veteran', 'Elite', 'Hero'][ev.rank]} (rank ${ev.rank})`, pos: u.pos });
          break;
        }
        case 'suppressed': {
          const u = this.ctx.sim.get(ev.id);
          if (ev.pinned && u?.owner === me) this.attackAlert(u.pos, false);
          break;
        }
        case 'superweaponLaunched': {
          const own = a.isAlly(ev.player, me);
          const arriveMs = performance.now() + Math.max(0, ev.arrive - (this.ctx.sim.gameTick ?? this.ctx.sim.tick)) * (1000 / SIM_HZ);
          this.strike.add(arriveMs, own, () => this.ctx.camera.lookAt(ev.at.x, ev.at.z));
          this.alert({ kind: own ? 'info' : 'attack', text: own ? 'Cruise missile launched' : 'WARNING: enemy cruise missile inbound — clear the marked area', pos: ev.at });
          this.minimap.ping(ev.at, '#ff2a1a');
          this.minimap.mark(ev.at, ev.radius, arriveMs);
          break;
        }
        case 'morale': {
          const mine = ev.team === a.teamOf(me);
          if (ev.low) this.alert({ kind: mine ? 'lost' : 'capture', text: mine ? 'Our Morale is breaking: pinned troops recover slowly. Retake points!' : 'Enemy Morale is breaking' });
          else this.alert({ kind: 'info', text: mine ? 'Our Morale is holding again' : 'Enemy Morale has steadied' });
          break;
        }
        case 'superweaponReady':
          if (isMe(ev.player)) this.alert({ kind: 'ready', text: 'Cruise missile ready (Strategic Command)' });
          break;
        case 'paused': {
          const by = a.slot(ev.by)?.name;
          this.alert({ kind: 'info', text: ev.paused ? `Game paused${by ? ` by ${by}` : ''}` : `Game resumed${by ? ` by ${by}` : ''}` });
          break;
        }
        case 'pauseVote':
          if (ev.paused && !isMe(ev.player)) this.alert({ kind: 'info', text: `${a.slot(ev.player)?.name ?? 'A player'} wants to pause (${ev.votes}/${ev.needed})` });
          break;
        case 'blocked': {
          const now = performance.now();
          if (isMe(ev.player) && now - (this.lastBlock.get(ev.reason) ?? -1e9) > 6000) {
            this.lastBlock.set(ev.reason, now);
            this.alert({ kind: 'warn', text: BLOCK_TEXT[ev.reason] });
          }
          break;
        }
        case 'defeated': {
          const name = a.slot(ev.player)?.name ?? `Player ${ev.player + 1}`;
          this.alert({ kind: isMe(ev.player) ? 'lost' : 'info', text: isMe(ev.player) ? 'You have been defeated' : `${name} has been defeated` });
          break;
        }
        case 'victory':
          this.finish(ev.team, ev.tick);
          break;
      }
    }
  }

  private finish(team: TeamId | null, tick: number, reason?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.input.setEnabled(false);
    this.menu.hide();
    const myTeam = this.adapter.teamOf(this.ctx.localPlayer);
    const text = team === null ? 'DRAW' : team === myTeam ? 'VICTORY' : 'DEFEAT';
    this.el.appendChild(outcomeBanner(text, team === null ? 'draw' : team === myTeam ? 'win' : 'loss'));
    this.stats.finish(tick);
    const facts = this.stats.facts;
    facts.won = team === null ? null : team === myTeam;
    facts.durationSec = tick / SIM_HZ;
    facts.mode = this.ctx.mode;
    const result: MatchResult = {
      setup: this.ctx.setup,
      localPlayer: this.ctx.localPlayer,
      winnerTeam: team,
      durationSec: tick / SIM_HZ,
      stats: this.stats.all(),
      reason: reason ?? this.reasonFor(team),
      timeline: this.stats.timeline,
      facts,
      mode: this.ctx.mode,
      mapName: this.ctx.map.name,
    };
    setTimeout(() => this.ctx.onMatchEnd?.(result), 2600);
  }

  private reasonFor(team: TeamId | null): string | undefined {
    if (team === null || this.ctx.setup.victory !== 'frontline') return this.ctx.setup.victory === 'annihilation' ? 'Enemy production destroyed' : undefined;
    // Explain it from our side: why we lost, or how the last enemy fell.
    const myTeam = this.adapter.teamOf(this.ctx.localPlayer);
    const morale = this.adapter.teamMorale();
    if (team !== myTeam) {
      const mine = morale.find((t) => t.team === myTeam);
      return mine && mine.morale <= 0 ? 'Morale broken' : 'Our HQ was destroyed';
    }
    const losers = morale.filter((t) => t.team !== team);
    return losers.every((t) => t.morale <= 0) ? 'Morale broken' : 'Enemy HQ destroyed';
  }

  /** End the match from outside (e.g. everyone else left). */
  endMatch(winnerTeam: TeamId | null, reason?: string): void {
    this.finish(winnerTeam, this.ctx.sim.gameTick ?? this.ctx.sim.tick, reason);
  }

  setNetStatus(s: NetStatus): void {
    this.net = { ...this.net, ...s };
    this.waiting.set(this.net.waitingFor ?? []);
    if (this.net.desyncTick !== undefined && this.net.desyncTick !== null && !this.desync.visible) {
      this.desync.show(this.net.desyncTick);
      this.input.setEnabled(false);
    }
  }

  /** Once per rendered frame. */
  frame(dt: number): void {
    const now = performance.now();
    this.input.prune();
    this.topbar.update(this.ctx.sim.gameTick ?? this.ctx.sim.tick, dt, { showFps: this.ctx.settings.get().showFps, pingMs: this.net.pingMs });
    this.minimap.update(now);
    this.selection.update(now);
    this.card.update(now);
    this.groups.update(now);
    this.production.update(now);
    this.replayBar?.update(now);
    this.alerts.update(now);
    this.waiting.update(now);
    this.strike.update(now);
    this.updatePause();
  }

  private updatePause(): void {
    const p = this.adapter.pause();
    if (!p || this.ctx.mode !== 'online') return this.pauseOverlay.set(null);
    const me = this.ctx.localPlayer;
    this.pauseOverlay.set({
      paused: p.paused,
      votes: p.votes.length,
      needed: p.needed,
      mine: p.votes.includes(me),
      left: p.left[me] ?? 0,
    });
  }


  dispose(): void {
    for (const c of this.cleanup) c();
    this.touch?.dispose();
    this.input.dispose();
    this.el.remove();
  }
}
