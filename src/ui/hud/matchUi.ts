import type { Command } from '../../shared/commands';
import type { MapDef, UnitDef } from '../../shared/data';
import type { SimView } from '../../shared/entities';
import type { SimEvent } from '../../shared/events';
import { SIM_HZ, type EntityId, type MatchSetup, type PlayerId, type TeamId, type Vec2 } from '../../shared/types';
import type { Picker } from '../../shared/view';
import { h } from '../dom';
import { InputController, isTyping, type TargetMode } from '../input';
import type { MatchMode } from '../lobbyApi';
import type { MatchResult } from '../screens/results';
import type { SettingsStore } from '../settings';
import { SimAdapter, type StructureInfo } from '../simAdapter';
import { AlertFeed, type Alert } from './alerts';
import { CommandCard } from './commandCard';
import { GroupBar } from './groups';
import { Minimap, type CameraControl } from './minimap';
import { DesyncOverlay, GameMenu, WaitingOverlay, outcomeBanner } from './overlays';
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
}

const ATTACK_ALERT_COOLDOWN_MS = 12000;
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
  private readonly waiting = new WaitingOverlay();
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
    this.stats = new StatsTracker(sim, setup);

    this.input = new InputController(ctx.canvas, sim, ctx.picker, localPlayer, (cmd) => ctx.issue(cmd), (ids) => this.onSelection(ids), {
      keyboard: false,
      keybinds: () => ctx.settings.get().keybinds,
      isFactory: (e) => this.adapter.producible(e).length > 0,
      canPlace: (s, at) => this.adapter.canPlace(s, at, ctx.map.size),
      onModeChange: (m) => this.onMode(m),
      onFormationDrag: (a, b) => this.drawArrow(a, b),
      onPlacementHover: (s, w, valid) => this.drawGhost(s, w, valid),
      onOrderMarker: (s, kind) => this.marker(s, kind),
    });

    this.topbar = new TopBar(this.adapter, localPlayer, () => this.openMenu());
    this.minimap = new Minimap(sim, this.adapter, ctx.picker, ctx.camera, ctx.map.size, localPlayer, (p, shift) => this.minimapOrder(p, shift), ctx.render?.minimapImage);
    this.selection = new SelectionPanel(sim, this.adapter, this.input, ctx.issue);
    this.card = new CommandCard(sim, this.adapter, this.input, localPlayer, ctx.issue, () => ctx.settings.get().keybinds, (msg) => this.alert({ kind: 'warn', text: msg }));
    this.groups = new GroupBar(sim, this.adapter, this.input, (n, add, center) => this.recallGroup(n, add, center));
    this.alerts = new AlertFeed((p) => ctx.camera.lookAt(p.x, p.z));
    this.desync = new DesyncOverlay(() => ctx.onQuit?.(), ctx.onDesyncReport);
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
    });

    this.ghost = h('div', { class: 'place-ghost hidden' }, h('span', { class: 'ghost-label mono' }));
    this.arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrow.setAttribute('class', 'formation-arrow hidden');
    this.arrow.innerHTML =
      '<defs><marker id="fl-arrowhead" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs><line marker-end="url(#fl-arrowhead)"/><circle r="5"/>';
    this.fx = h('div', { class: 'hud-fx' }, this.ghost, this.arrow);

    this.el = h(
      'div',
      { class: 'hud' },
      this.fx,
      this.topbar.el,
      h('div', { class: 'hud-left' }, this.alerts.el),
      h('div', { class: 'hud-bottom' }, this.minimap.el, h('div', { class: 'hud-center' }, this.groups.el, this.selection.el), this.card.el),
      this.waiting.el,
      this.menu.el,
      this.desync.el,
    );
    ctx.root.appendChild(this.el);
    this.applySettings();
    this.cleanup.push(ctx.settings.subscribe(() => this.applySettings()));

    const onKey = (e: KeyboardEvent) => this.onKey(e);
    addEventListener('keydown', onKey);
    this.cleanup.push(() => removeEventListener('keydown', onKey));

    this.selection.update(performance.now(), true);
    this.card.update(performance.now(), true);
    this.alert({ kind: 'info', text: `${ctx.map.name} — ${setup.victory === 'frontline' ? 'hold the strategic points' : 'destroy all enemy production'}` });
  }

  private applySettings(): void {
    const s = this.ctx.settings.get();
    this.el.style.setProperty('--ui-scale', String(s.uiScale));
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

    const digit = /^Digit([1-9])$/.exec(code)?.[1];
    if (digit) {
      const n = Number(digit);
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

  private openMenu(): void {
    if (this.ended) return;
    this.input.cancelMode();
    this.menu.show();
    this.input.setEnabled(false);
    if (this.ctx.mode === 'skirmish') this.ctx.onPauseChange?.(true);
  }

  private closeMenu(): void {
    this.menu.hide();
    this.input.setEnabled(true);
    if (this.ctx.mode === 'skirmish') this.ctx.onPauseChange?.(false);
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
    if (a.pos && (a.kind === 'attack' || a.kind === 'lost')) this.minimap.ping(a.pos, '#ff5a3c');
    else if (a.pos && a.kind === 'capture') this.minimap.ping(a.pos, '#e3b23c');
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
    const me = this.ctx.localPlayer;
    const a = this.adapter;
    for (const ev of events) {
      switch (ev.type) {
        case 'underAttack':
          if (ev.player === me) this.attackAlert(ev.at, true);
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
        case 'built': {
          const e = this.ctx.sim.get(ev.id);
          if (e?.owner === me) this.alert({ kind: 'ready', text: `Construction complete: ${a.displayName(e.type)}`, pos: e.pos });
          break;
        }
        case 'produced': {
          const f = this.ctx.sim.get(ev.factory);
          const u = this.ctx.sim.get(ev.unit);
          if (f?.owner === me && u) this.alert({ kind: 'ready', text: `${a.displayName(u.type)} ready`, pos: u.pos });
          break;
        }
        case 'died': {
          const v = this.stats.info(ev.id);
          if (v?.owner === me && v.kind === 'structure') this.alert({ kind: 'lost', text: `${a.displayName(v.type)} destroyed`, pos: this.ctx.sim.get(ev.id)?.pos });
          break;
        }
        case 'defeated': {
          const name = a.slot(ev.player)?.name ?? `Player ${ev.player + 1}`;
          this.alert({ kind: ev.player === me ? 'lost' : 'info', text: ev.player === me ? 'You have been defeated' : `${name} has been defeated` });
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
    const result: MatchResult = {
      setup: this.ctx.setup,
      localPlayer: this.ctx.localPlayer,
      winnerTeam: team,
      durationSec: tick / SIM_HZ,
      stats: this.stats.all(),
      reason: reason ?? this.reasonFor(team),
    };
    setTimeout(() => this.ctx.onMatchEnd?.(result), 2600);
  }

  private reasonFor(team: TeamId | null): string | undefined {
    if (team === null || this.ctx.setup.victory !== 'frontline') return this.ctx.setup.victory === 'annihilation' ? 'Enemy production destroyed' : undefined;
    const losers = this.adapter.teamTickets().filter((t) => t.team !== team);
    return losers.every((t) => t.tickets <= 0) ? 'Tickets depleted' : 'Enemy HQ destroyed';
  }

  /** End the match from outside (e.g. everyone else left). */
  endMatch(winnerTeam: TeamId | null, reason?: string): void {
    this.finish(winnerTeam, this.ctx.sim.tick, reason);
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
    this.topbar.update(this.ctx.sim.tick, dt, { showFps: this.ctx.settings.get().showFps, pingMs: this.net.pingMs });
    this.minimap.update(now);
    this.selection.update(now);
    this.card.update(now);
    this.groups.update(now);
    this.alerts.update(now);
    this.waiting.update(now);
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.input.dispose();
    this.el.remove();
  }
}
