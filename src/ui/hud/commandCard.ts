import type { Command } from '../../shared/commands';
import type { EntityState, SimView } from '../../shared/entities';
import type { EntityId, PlayerId } from '../../shared/types';
import { fmtInt, h, setChildren } from '../dom';
import { abilityIcon, entityIcon, icon, type IconId } from '../icons';
import type { InputController } from '../input';
import { keyLabel, SLOT_ACTIONS, type Keybinds } from '../keybinds';
import type { SimAdapter } from '../simAdapter';
import { bindTip, type TipContent } from '../tooltip';
import { abilityTip, productionTip, requirementText, STRUCTURE_DATA } from '../unitInfo';

interface CardButton {
  id: string;
  icon: string;
  label: string;
  /** KeyboardEvent.code that triggers it ('' = none). */
  key: string;
  cost?: number;
  /** Small count in the corner (queued units, passengers). */
  badge?: string;
  /** 0..1 progress bar along the bottom (unit in production). */
  progress?: number;
  /** 0..1 cooldown left (sweep overlay) and seconds left. */
  cooldown?: number;
  cooldownText?: string;
  active?: boolean;
  /** Can't afford right now (still clickable: it explains why). */
  poor?: boolean;
  /** Locked by tier or requirements. */
  locked?: boolean;
  /** Highlight (superweapon ready). */
  ready?: boolean;
  tip(): TipContent;
  run(shift: boolean): void;
  /** Right click (cancel one queued unit). */
  alt?(): void;
}

export const CARD_COLS = 5;
const ROWS = 3;
const REFRESH_MS = 100;

interface CellRefs {
  el: HTMLElement;
  badge: HTMLElement;
  bar: HTMLElement;
  sweep: HTMLElement;
  cd: HTMLElement;
}

/**
 * Bottom-right grid of orders, construction and production. Every button has a hotkey from the
 * live keybinds and a tooltip with costs, counters and cooldowns. The cell layout is rebuilt only
 * when the set of buttons changes; badges, progress and cooldowns update in place.
 */
export class CommandCard {
  readonly el: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private buttons: CardButton[] = [];
  private cells: (CellRefs | null)[] = [];
  private submenu: 'build' | null = null;
  private layoutKey = '';
  private last = 0;

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly input: InputController,
    private readonly local: PlayerId,
    private readonly issue: (cmd: Command) => void,
    private readonly keybinds: () => Keybinds,
    private readonly notify: (msg: string) => void,
  ) {
    this.grid = h('div', { class: 'card-grid' });
    this.title = h('span', { class: 'card-title' });
    this.hint = h('span', { class: 'card-hint' });
    this.el = h('div', { class: 'hud-panel command-card' }, h('div', { class: 'card-head' }, this.title, this.hint), this.grid);
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Close the build sub-menu (Esc). Returns true if it was open. */
  back(): boolean {
    if (!this.submenu) return false;
    this.submenu = null;
    this.update(performance.now(), true);
    return true;
  }

  selectionChanged(): void {
    this.submenu = null;
    this.update(performance.now(), true);
  }

  private selected(): EntityState[] {
    const out: EntityState[] = [];
    for (const id of this.input.selection) {
      const e = this.sim.get(id);
      if (e && this.adapter.canOrder(this.local, e)) out.push(e);
    }
    return out;
  }

  private slotKey(i: number): string {
    const a = SLOT_ACTIONS[i];
    return a ? this.keybinds()[a] : '';
  }

  private build(): { title: string; hint: string; buttons: CardButton[] } {
    const k = this.keybinds();
    const a = this.adapter;
    const sel = this.selected();
    const mode = this.input.getMode();
    const army = a.armyOf(this.local);
    const eco = a.economy(army);
    const supply = eco.supply;

    if (mode.kind === 'place') {
      const s = a.structures[mode.structure];
      return {
        title: `Place ${s?.name ?? mode.structure}`,
        hint: 'Shift: place several',
        buttons: [
          { id: 'rotate', icon: icon('rotate'), label: 'Rotate', key: k.rotateStructure, tip: () => ({ title: 'Rotate 90°', icon: icon('rotate', 'ic-md'), keys: [[keyLabel(k.rotateStructure), 'Rotate']] }), run: () => this.input.rotatePlacement() },
          { id: 'cancel', icon: icon('cancel'), label: 'Cancel', key: 'Escape', tip: () => ({ title: 'Cancel placement', keys: [['Esc', 'Cancel'], ['Right-click', 'Cancel']] }), run: () => this.input.cancelMode() },
        ],
      };
    }

    const units = sel.filter((e) => e.kind === 'unit');
    const builders = units.filter((e) => a.isBuilder(e));
    const owned = a.ownedStructures(army);
    if (this.submenu === 'build' && builders.length) {
      const allowed = new Set(builders.flatMap((b) => a.buildOptions(b).map((s) => s.id)));
      const builderFor = (id: string) => builders.find((b) => a.buildOptions(b).some((s) => s.id === id)) ?? builders[0];
      const all = Object.keys(STRUCTURE_DATA).filter((id) => STRUCTURE_DATA[id].buildable !== false && !(STRUCTURE_DATA[id] as { neutral?: boolean }).neutral && a.structures[id]);
      const buttons: CardButton[] = all.slice(0, CARD_COLS * ROWS - 1).map((id, i) => {
        const s = a.structures[id];
        const locked = !allowed.has(id);
        const reason = locked ? (requirementText(id, eco.tier, (r) => owned.has(r)) ?? 'Not available yet') : null;
        const key = this.slotKey(i);
        return {
          id: `build:${id}`,
          icon: entityIcon(id),
          label: s.name,
          key,
          cost: s.cost,
          poor: s.cost > supply,
          locked,
          tip: () => productionTip(id, { supply: a.economy(army).supply, hotkey: key ? keyLabel(key) : undefined, locked: reason, icon: entityIcon(id, undefined, 'ic-md') }),
          run: () => {
            if (locked) return this.notify(reason ?? 'Not available yet');
            if (s.cost > a.economy(army).supply) return this.notify('Not enough supply');
            this.input.beginPlacement(id, builderFor(id).id);
          },
        };
      });
      buttons.push({ id: 'back', icon: icon('back'), label: 'Back', key: 'Escape', tip: () => ({ title: 'Back to orders', keys: [['Esc', 'Back']] }), run: () => this.back() });
      return { title: 'Construct', hint: `${builders.length} engineer${builders.length > 1 ? 's' : ''}`, buttons };
    }

    if (units.length) {
      const order = (id: string, ic: IconId, label: string, key: string, body: string, run: (shift: boolean) => void, active = false, extra: Partial<CardButton> = {}): CardButton => ({
        id,
        icon: icon(ic),
        label,
        key,
        active,
        tip: () => ({ title: label, icon: icon(ic, 'ic-md'), body: [body], keys: key ? [[keyLabel(key), label], ...((extra as { keys?: [string, string][] }).keys ?? [])] : undefined }),
        run,
        ...extra,
      });
      const buttons: CardButton[] = [
        order('attack', 'attackMove', 'Attack-move', k.attackMove, 'Move to a spot, engaging every enemy on the way. Right-click an enemy to attack it directly.', () => this.input.armAttackMove(), mode.kind === 'attackMove'),
        order('stop', 'stop', 'Stop', k.stop, 'Cancel all orders.', () => this.input.stop()),
        order('hold', 'hold', 'Hold position', k.hold, 'Stay put and return fire. Units will not chase.', () => this.input.hold()),
        order('patrol', 'patrol', 'Patrol', k.patrol, 'Walk back and forth between here and a point, engaging anything on the way.', () => this.input.setMode({ kind: 'patrol' }), mode.kind === 'patrol'),
      ];
      if (builders.length) buttons.push(order('build', 'build', 'Build', k.build, 'Open the construction menu. Engineers build anywhere near your base and points.', () => this.openBuild()));
      if (units.some((u) => a.unitDef(u.type)?.domain === 'ground' && a.unitDef(u.type)?.armor === 'infantry')) {
        buttons.push(order('enter', 'enter', 'Board / garrison', k.enter, 'Click a transport (IFV, transport helicopter or ship), a building or a trench to get in. Right-clicking one works too.', () => this.input.setMode({ kind: 'enter' }), mode.kind === 'enter'));
      }
      const carrying = units.filter((u) => (u.cargo?.length ?? 0) > 0);
      if (carrying.length) {
        const n = carrying.reduce((s, u) => s + (u.cargo?.length ?? 0), 0);
        buttons.push(
          order('unload', 'unload', 'Unload', k.unload, 'Click where the passengers should get out (ships stop at the beach).', (shift) => {
            if (shift) this.issue({ type: 'unload', units: carrying.map((u) => u.id) });
            else this.input.setMode({ kind: 'unload' });
          }, mode.kind === 'unload', { badge: String(n), keys: [['Shift', 'Unload right here']] } as Partial<CardButton>),
        );
      }
      const lines = [...new Set(units.map((u) => u.line ?? 0).filter((l) => l > 0))];
      buttons.push(
        order('line', 'line', lines.length === 1 ? 'Redraw line' : 'Frontline', k.drawLine, `Hold ${keyLabel(k.drawLine)} and drag on the map. Units spread along the line by role (infantry into cover, AT on the flanks, tanks behind, artillery far back), face the enemy and hold it. Shift+${keyLabel(k.drawLine)} reinforces the selected line.`, () => this.input.setMode({ kind: 'line' }), mode.kind === 'line'),
      );
      if (lines.length) {
        buttons.push(
          order('advance', 'advance', 'Advance line', k.advanceLine, 'Push the whole line 40 m toward the enemy.', (shift) => {
            for (const line of lines) this.issue({ type: 'advanceLine', line, distance: shift ? -40 : 40 });
          }, false, { keys: [['Shift', 'Pull back 40 m']] } as Partial<CardButton>),
          order('disband', 'disband', 'Disband line', k.disbandLine, 'Units stop holding the line and stay where they are.', () => lines.forEach((line) => this.issue({ type: 'disbandLine', line }))),
        );
      }
      // Abilities shared by the selection, on the slot keys.
      const abil = new Map<string, { ready: EntityId[]; casters: EntityId[]; cd: number; active: boolean; cooldown: number; target: string; cost: number }>();
      for (const u of units) {
        for (const ab of a.abilities(u)) {
          let g = abil.get(ab.ability);
          if (!g) abil.set(ab.ability, (g = { ready: [], casters: [], cd: 1, active: false, cooldown: ab.info.cooldown, target: ab.info.target, cost: ab.info.cost }));
          g.casters.push(u.id);
          if (ab.cooldown <= 0) g.ready.push(u.id);
          g.cd = Math.min(g.cd, ab.cooldown);
          g.active ||= ab.active;
        }
      }
      let slot = 0;
      for (const [id, g] of abil) {
        if (buttons.length >= CARD_COLS * ROWS) break;
        const key = this.slotKey(slot++);
        const left = g.cd * g.cooldown;
        const name = a.abilityInfo(id)?.name ?? id;
        buttons.push({
          id: `ability:${id}`,
          icon: abilityIcon(id),
          label: name,
          key,
          cost: g.cost || undefined,
          poor: g.cost > supply,
          cooldown: g.ready.length ? 0 : g.cd,
          cooldownText: g.ready.length ? '' : `${Math.ceil(left)}`,
          active: g.active || (mode.kind === 'ability' && mode.ability === id),
          badge: g.casters.length > 1 && g.ready.length ? String(g.ready.length) : undefined,
          tip: () => abilityTip(id, { hotkey: key ? keyLabel(key) : undefined, cooldownLeft: left, casters: g.casters.length, ready: g.ready.length, icon: abilityIcon(id, 'ic-md'), active: g.active }),
          run: (shift) => {
            if (!g.ready.length) return this.notify(`${name} is recharging (${Math.ceil(left)}s)`);
            if (g.target === 'self') this.issue({ type: 'useAbility', units: g.ready, ability: id, queue: shift });
            else this.input.setMode({ kind: 'ability', ability: id, target: g.target === 'unit' ? 'unit' : 'point', units: g.ready });
          },
        });
      }
      const types = new Set(units.map((u) => u.type));
      return { title: types.size === 1 ? a.displayName([...types][0]) : `${units.length} units`, hint: 'Shift: queue', buttons };
    }

    const structures = sel.filter((e) => e.kind === 'structure');
    if (structures.length) {
      const type = structures[0].type;
      const same = structures.filter((s) => s.type === type && a.buildProgress(s) === undefined);
      if (!same.length) return { title: a.displayName(type), hint: 'Under construction', buttons: [] };
      const producible = new Set(a.producible(same[0]));
      const all = a.allProduces(type).filter((u) => a.units[u]);
      const queues = same.map((f) => a.queue(f));
      const buttons: CardButton[] = all.slice(0, CARD_COLS * ROWS - 3).map((u, i) => {
        const def = a.units[u];
        const queued = queues.reduce((n, q) => n + q.filter((x) => x.unit === u).length, 0);
        const front = queues.map((q) => (q[0]?.unit === u ? q[0].progress : -1)).reduce((m, p) => Math.max(m, p), -1);
        const locked = !producible.has(u);
        const reason = locked ? (requirementText(u, eco.tier, (r) => owned.has(r)) ?? 'Not available yet') : null;
        const key = this.slotKey(i);
        const cost = def?.cost ?? 0;
        return {
          id: `produce:${u}`,
          icon: entityIcon(u, def),
          label: a.displayName(u),
          key,
          cost,
          badge: queued ? String(queued) : undefined,
          progress: front >= 0 ? front : undefined,
          poor: cost > supply,
          locked,
          tip: () => productionTip(u, { supply: a.economy(army).supply, hotkey: key ? keyLabel(key) : undefined, locked: reason, queued, icon: entityIcon(u, def, 'ic-md') }),
          run: (shift) => {
            if (locked) return this.notify(reason ?? 'Not available yet');
            if (cost > a.economy(army).supply) return this.notify('Not enough supply');
            // Spread across the selected factories: shortest queue first.
            const f = [...same].sort((x, y) => a.queue(x).length - a.queue(y).length)[0];
            this.issue({ type: 'produce', factory: f.id, unit: u, count: shift ? 5 : 1 });
          },
          alt: () => this.cancelOne(same, u),
        };
      });
      if (all.length) {
        buttons.push({
          id: 'rally',
          icon: icon('rally'),
          label: 'Rally point',
          key: this.slotKey(Math.min(buttons.length, SLOT_ACTIONS.length - 1)),
          active: mode.kind === 'rally',
          tip: () => ({ title: 'Set rally point', icon: icon('rally', 'ic-md'), body: ['Where new units gather. Right-clicking the map with only factories selected sets it too.'] }),
          run: () => this.input.setMode({ kind: 'rally', factories: same.map((s) => s.id) }),
        });
      }
      const garrisoned = same.filter((s) => (s.cargo?.length ?? 0) > 0);
      if (garrisoned.length) {
        buttons.push({
          id: 'unload',
          icon: icon('unload'),
          label: 'Evacuate',
          key: k.unload,
          badge: String(garrisoned.reduce((n, s) => n + (s.cargo?.length ?? 0), 0)),
          tip: () => ({ title: 'Evacuate', icon: icon('unload', 'ic-md'), body: ['Order the garrison out.'], keys: [[keyLabel(k.unload), 'Evacuate']] }),
          run: () => this.issue({ type: 'unload', units: garrisoned.map((s) => s.id) }),
        });
      }
      if (a.structures[type]?.superweapon) {
        const sw = a.superweapon(army);
        const pct = Math.floor((sw?.charge ?? 0) * 100);
        const key = this.slotKey(0);
        buttons.push({
          id: 'superweapon',
          icon: icon('missile'),
          label: 'Cruise missile',
          key,
          ready: !!sw?.ready,
          cooldown: sw?.ready ? 0 : 1 - (sw?.charge ?? 0),
          cooldownText: sw?.ready ? '' : `${pct}%`,
          active: mode.kind === 'superweapon',
          tip: () => ({
            title: 'Cruise missile',
            sub: sw?.ready ? 'Ready to launch' : `Charging: ${pct}%`,
            icon: icon('missile', 'ic-md'),
            body: ['Strategic strike anywhere on the map. Everyone sees the target marker 12 seconds before impact, so they can scatter. Recharges for 6 minutes.'],
            keys: key ? [[keyLabel(key), 'Aim']] : undefined,
            warn: sw?.ready ? undefined : 'Still charging',
          }),
          run: () => {
            if (!sw?.ready) return this.notify(`Cruise missile charging (${pct}%)`);
            this.input.setMode({ kind: 'superweapon' });
          },
        });
      }
      const total = queues.reduce((n, q) => n + q.length, 0);
      return { title: same.length > 1 ? `${a.displayName(type)} ×${same.length}` : a.displayName(type), hint: all.length ? (total ? `${total} queued · Shift ×5` : 'Shift ×5 · Right-click cancels') : '', buttons };
    }
    return { title: '', hint: '', buttons: [] };
  }

  /** Right click on a production button: cancel the last queued unit of that type. */
  private cancelOne(factories: EntityState[], unit: string): void {
    for (const f of [...factories].reverse()) {
      const q = this.adapter.queue(f);
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].unit === unit) {
          this.issue({ type: 'cancelProduce', factory: f.id, index: i });
          return;
        }
      }
    }
  }

  private openBuild(): void {
    this.submenu = 'build';
    this.update(performance.now(), true);
  }

  update(now = performance.now(), force = false): void {
    if (!force && now - this.last < REFRESH_MS) return;
    this.last = now;
    const { title, hint, buttons } = this.build();
    this.buttons = buttons;
    const layout = JSON.stringify([title, buttons.map((b) => [b.id, b.key, b.locked])]);
    if (layout !== this.layoutKey) {
      this.layoutKey = layout;
      this.rebuild(buttons);
    }
    if (this.title.textContent !== title) this.title.textContent = title;
    if (this.hint.textContent !== hint) this.hint.textContent = hint;
    buttons.forEach((b, i) => this.paint(this.cells[i], b));
    this.el.classList.toggle('empty', buttons.length === 0);
  }

  private rebuild(buttons: CardButton[]): void {
    this.cells = [];
    const els: HTMLElement[] = [];
    for (let i = 0; i < CARD_COLS * ROWS; i++) {
      const b = buttons[i];
      if (!b) {
        els.push(h('span', { class: 'card-cell empty' }));
        this.cells.push(null);
        continue;
      }
      const badge = h('span', { class: 'cell-badge' });
      const bar = h('span', { class: 'cell-bar' });
      const sweep = h('span', { class: 'cell-sweep' });
      const cd = h('span', { class: 'cell-cd' });
      const id = b.id;
      const el = h(
        'button',
        {
          class: 'card-cell',
          type: 'button',
          dataset: { id },
          'aria-label': b.label,
          onclick: (e: MouseEvent) => this.trigger(id, e.shiftKey),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            this.buttons.find((x) => x.id === id)?.alt?.();
            this.update(performance.now(), true);
          },
        },
        h('span', { class: 'cell-icon', html: b.icon }),
        sweep,
        cd,
        b.key ? h('span', { class: 'cell-key' }, keyLabel(b.key)) : null,
        b.cost ? h('span', { class: 'cell-cost' }, fmtInt(b.cost)) : null,
        b.locked ? h('span', { class: 'cell-lock', html: icon('lock', 'ic-sm') }) : null,
        badge,
        bar,
      );
      bindTip(el, () => this.buttons.find((x) => x.id === id)?.tip() ?? null);
      els.push(el);
      this.cells.push({ el, badge, bar, sweep, cd });
    }
    setChildren(this.grid, els);
  }

  private paint(c: CellRefs | null, b: CardButton): void {
    if (!c) return;
    const cls = c.el.classList;
    cls.toggle('active', !!b.active);
    cls.toggle('poor', !!b.poor && !b.locked);
    cls.toggle('locked', !!b.locked);
    cls.toggle('ready', !!b.ready);
    cls.toggle('cooling', !!b.cooldown);
    const badge = b.badge ?? '';
    if (c.badge.textContent !== badge) c.badge.textContent = badge;
    const prog = b.progress !== undefined ? `${(b.progress * 100).toFixed(1)}%` : '0%';
    if (c.bar.style.width !== prog) c.bar.style.width = prog;
    const cd = b.cooldown ? `${(b.cooldown * 360).toFixed(0)}deg` : '0deg';
    if (c.sweep.style.getPropertyValue('--cd') !== cd) c.sweep.style.setProperty('--cd', cd);
    const cdt = b.cooldownText ?? '';
    if (c.cd.textContent !== cdt) c.cd.textContent = cdt;
  }

  private trigger(id: string, shift: boolean): void {
    const b = this.buttons.find((x) => x.id === id);
    if (!b) return;
    b.run(shift);
    const el = this.grid.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    this.update(performance.now(), true);
  }

  /** Hotkey dispatch. Returns true if a card button took the key. */
  handleKey(code: string, shift: boolean): boolean {
    this.update(performance.now(), true);
    const b = this.buttons.find((x) => x.key === code);
    if (!b) return false;
    this.trigger(b.id, shift);
    return true;
  }
}
