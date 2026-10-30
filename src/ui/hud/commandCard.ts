import type { Command } from '../../shared/commands';
import type { EntityState, SimView } from '../../shared/entities';
import type { EntityId, PlayerId } from '../../shared/types';
import { fmtInt, h, setChildren } from '../dom';
import { ICONS, abilityIcon, glyphFor } from '../glyphs';
import type { InputController } from '../input';
import { keyLabel, SLOT_ACTIONS, type Keybinds } from '../keybinds';
import type { SimAdapter } from '../simAdapter';

interface CardButton {
  id: string;
  icon: string;
  label: string;
  /** KeyboardEvent.code that triggers it. */
  key: string;
  cost?: number;
  /** Small count in the corner (queued units). */
  badge?: string;
  active?: boolean;
  disabled?: boolean;
  detail?: string;
  run(shift: boolean): void;
}

const COLS = 4;
const ROWS = 3;
const REFRESH_MS = 100;

/**
 * Bottom-right grid of orders, build options and production. Every button has a hotkey (from the
 * keybinds); MatchUi forwards key presses to `handleKey`.
 */
export class CommandCard {
  readonly el: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly title: HTMLElement;
  private buttons: CardButton[] = [];
  private submenu: 'build' | null = null;
  private key = '';
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
    this.tip = h('div', { class: 'card-tip' });
    this.title = h('div', { class: 'card-title eyebrow mono' });
    this.el = h('div', { class: 'hud-panel command-card' }, this.title, this.grid, this.tip);
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
      if (e && e.owner === this.local) out.push(e);
    }
    return out;
  }

  private build(): { title: string; buttons: CardButton[] } {
    const k = this.keybinds();
    const sel = this.selected();
    const mode = this.input.getMode();
    const supply = this.adapter.economy(this.local).supply;

    if (mode.kind === 'place') {
      const s = this.adapter.structures[mode.structure];
      return {
        title: `PLACE ${s?.name.toUpperCase() ?? mode.structure}`,
        buttons: [
          { id: 'rotate', icon: ICONS.patrol, label: 'Rotate', key: k.rotateStructure, detail: 'Rotate 90°', run: () => this.input.rotatePlacement() },
          { id: 'cancel', icon: ICONS.cancel, label: 'Cancel', key: 'Escape', detail: 'Stop placing (Esc or right click)', run: () => this.input.cancelMode() },
        ],
      };
    }

    const units = sel.filter((e) => e.kind === 'unit');
    const builders = units.filter((e) => this.adapter.isBuilder(e));
    if (this.submenu === 'build' && builders.length) {
      const options = new Map<string, EntityId>();
      for (const b of builders) for (const s of this.adapter.buildOptions(b)) if (!options.has(s.id)) options.set(s.id, b.id);
      const buttons: CardButton[] = [...options.entries()].slice(0, SLOT_ACTIONS.length).map(([id, builder], i) => {
        const s = this.adapter.structures[id];
        return {
          id: `build:${id}`,
          icon: glyphFor(id),
          label: s.name,
          key: k[SLOT_ACTIONS[i]],
          cost: s.cost,
          detail: `${s.buildSeconds}s · power ${s.power > 0 ? '+' : ''}${s.power}${s.produces.length ? ` · trains ${s.produces.map((u) => this.adapter.displayName(u)).join(', ')}` : ''}`,
          disabled: s.cost > supply,
          run: () => {
            if (s.cost > supply) return this.notify('Not enough supply');
            this.input.beginPlacement(id, builder);
          },
        };
      });
      buttons.push({ id: 'back', icon: ICONS.back, label: 'Back', key: 'Escape', run: () => this.back() });
      return { title: 'CONSTRUCT', buttons };
    }

    if (units.length) {
      const am = mode.kind === 'attackMove';
      const buttons: CardButton[] = [
        { id: 'attack', icon: ICONS.attack, label: 'Attack-move', key: k.attackMove, active: am, detail: 'Move, engaging enemies on the way', run: () => this.input.armAttackMove() },
        { id: 'stop', icon: ICONS.stop, label: 'Stop', key: k.stop, detail: 'Cancel all orders', run: () => this.input.stop() },
        { id: 'hold', icon: ICONS.hold, label: 'Hold', key: k.hold, detail: 'Stay put and return fire', run: () => this.input.hold() },
        {
          id: 'patrol',
          icon: ICONS.patrol,
          label: 'Patrol',
          key: k.patrol,
          active: mode.kind === 'patrol',
          detail: 'Walk back and forth between here and a point, engaging anything on the way',
          run: () => this.input.setMode({ kind: 'patrol' }),
        },
      ];
      if (builders.length) buttons.push({ id: 'build', icon: ICONS.build, label: 'Build', key: k.build, detail: 'Open the construction menu (trenches hold 8 infantry)', run: () => this.openBuild() });
      if (units.some((u) => this.adapter.unitDef(u.type)?.domain === 'ground')) {
        buttons.push({
          id: 'enter',
          icon: ICONS.enter,
          label: 'Board / garrison',
          key: k.enter,
          active: mode.kind === 'enter',
          detail: 'Click a transport (IFV, transport helicopter or ship), a building or a trench to get in. Right-clicking one works too.',
          run: () => this.input.setMode({ kind: 'enter' }),
        });
      }
      const carrying = units.filter((u) => (u.cargo?.length ?? 0) > 0);
      if (carrying.length) {
        const n = carrying.reduce((a, u) => a + (u.cargo?.length ?? 0), 0);
        buttons.push({
          id: 'unload',
          icon: ICONS.unload,
          label: 'Unload',
          key: k.unload,
          badge: String(n),
          active: mode.kind === 'unload',
          detail: 'Click where the passengers should get out (ships stop at the beach). Shift: unload right here.',
          run: (shift) => {
            if (shift) this.issue({ type: 'unload', units: carrying.map((u) => u.id) });
            else this.input.setMode({ kind: 'unload' });
          },
        });
      }
      const lines = [...new Set(units.map((u) => u.line ?? 0).filter((l) => l > 0))];
      buttons.push({
        id: 'line',
        icon: ICONS.line,
        label: lines.length === 1 ? 'Redraw / reinforce line' : 'Frontline',
        key: k.drawLine,
        active: mode.kind === 'line',
        detail: `Hold ${keyLabel(k.drawLine)} and drag on the map: units spread along the line by role (infantry into cover, AT on the flanks, tanks behind, artillery far back) and hold it.`,
        run: () => this.input.setMode({ kind: 'line' }),
      });
      if (lines.length) {
        buttons.push({
          id: 'advance',
          icon: ICONS.advance,
          label: 'Advance line',
          key: k.advanceLine,
          detail: 'Push the whole line 40 m forward (Shift: pull it back 40 m)',
          run: (shift) => {
            for (const line of lines) this.issue({ type: 'advanceLine', line, distance: shift ? -40 : 40 });
          },
        });
        buttons.push({ id: 'disband', icon: ICONS.disband, label: 'Disband line', key: k.disbandLine, detail: 'Units stop holding the line and stay where they are', run: () => lines.forEach((line) => this.issue({ type: 'disbandLine', line })) });
      }
      // Abilities shared by the selection, on the slot keys.
      const abil = new Map<string, { info: NonNullable<ReturnType<SimAdapter['abilityInfo']>>; ready: EntityId[]; casters: EntityId[]; cd: number; active: boolean }>();
      for (const u of units) {
        for (const a of this.adapter.abilities(u)) {
          let g = abil.get(a.ability);
          if (!g) abil.set(a.ability, (g = { info: a.info, ready: [], casters: [], cd: 1, active: false }));
          g.casters.push(u.id);
          if (a.cooldown <= 0) g.ready.push(u.id);
          g.cd = Math.min(g.cd, a.cooldown);
          g.active ||= a.active;
        }
      }
      let slot = 0;
      for (const [id, g] of abil) {
        if (buttons.length >= COLS * ROWS) break;
        const secs = Math.ceil(g.cd * g.info.cooldown);
        buttons.push({
          id: `ability:${id}`,
          icon: abilityIcon(id),
          label: g.info.name,
          key: k[SLOT_ACTIONS[slot++ % SLOT_ACTIONS.length]],
          cost: g.info.cost || undefined,
          badge: g.ready.length ? undefined : `${secs}s`,
          active: g.active || (mode.kind === 'ability' && mode.ability === id),
          disabled: !g.ready.length,
          detail: `${g.info.target === 'self' ? 'Toggles/activates on the selected units' : g.info.target === 'point' ? 'Click a spot on the map' : 'Click a unit'} · cooldown ${g.info.cooldown}s${g.info.cost ? ` · ${g.info.cost} supply` : ''}`,
          run: (shift) => {
            if (!g.ready.length) return this.notify(`${g.info.name} is recharging`);
            if (g.info.target === 'self') this.issue({ type: 'useAbility', units: g.ready, ability: id, queue: shift });
            else this.input.setMode({ kind: 'ability', ability: id, target: g.info.target === 'unit' ? 'unit' : 'point', units: g.ready });
          },
        });
      }
      const types = new Set(units.map((u) => u.type));
      return { title: types.size === 1 ? this.adapter.displayName([...types][0]).toUpperCase() : 'ORDERS', buttons };
    }

    const structures = sel.filter((e) => e.kind === 'structure');
    if (structures.length) {
      const type = structures[0].type;
      const same = structures.filter((s) => s.type === type);
      const producible = this.adapter.producible(same[0]);
      const buttons: CardButton[] = producible.slice(0, SLOT_ACTIONS.length - 1).map((u, i) => {
        const def = this.adapter.units[u];
        const queued = same.reduce((n, f) => n + this.adapter.queue(f).filter((q) => q.unit === u).length, 0);
        const cost = def?.cost ?? 0;
        return {
          id: `produce:${u}`,
          icon: glyphFor(u, def),
          label: this.adapter.displayName(u),
          key: k[SLOT_ACTIONS[i]],
          cost,
          badge: queued ? String(queued) : undefined,
          disabled: cost > supply,
          detail: def ? `${def.buildSeconds}s · ${def.hp} hp · ${def.armor} · Shift: ×5` : 'Shift: ×5',
          run: (shift) => {
            if (cost > supply) return this.notify('Not enough supply');
            // Spread across the selected factories: shortest queue first.
            const f = [...same].sort((a, b) => this.adapter.queue(a).length - this.adapter.queue(b).length)[0];
            this.issue({ type: 'produce', factory: f.id, unit: u, count: shift ? 5 : 1 });
          },
        };
      });
      if (producible.length) {
        buttons.push({
          id: 'rally',
          icon: ICONS.rally,
          label: 'Rally',
          key: k[SLOT_ACTIONS[Math.min(buttons.length, SLOT_ACTIONS.length - 1)]],
          active: mode.kind === 'rally',
          detail: 'Set where new units gather (or right click the map)',
          run: () => this.input.setMode({ kind: 'rally', factories: same.map((s) => s.id) }),
        });
      }
      const garrisoned = same.filter((s) => (s.cargo?.length ?? 0) > 0);
      if (garrisoned.length) {
        buttons.push({
          id: 'unload',
          icon: ICONS.unload,
          label: 'Evacuate',
          key: k.unload,
          badge: String(garrisoned.reduce((a, s) => a + (s.cargo?.length ?? 0), 0)),
          detail: 'Order the garrison out',
          run: () => this.issue({ type: 'unload', units: garrisoned.map((s) => s.id) }),
        });
      }
      if (this.adapter.structures[type]?.superweapon) {
        const sw = this.adapter.superweapon(this.local);
        const pct = Math.floor((sw?.charge ?? 0) * 100);
        buttons.push({
          id: 'superweapon',
          icon: ICONS.missile,
          label: 'Cruise missile',
          key: k[SLOT_ACTIONS[0]],
          badge: sw?.ready ? 'READY' : `${pct}%`,
          active: mode.kind === 'superweapon',
          disabled: !sw?.ready,
          detail: 'Strategic strike on any point. Everyone sees the target marker 12 s before impact. Recharges for 6 minutes.',
          run: () => {
            if (!sw?.ready) return this.notify(`Cruise missile charging (${pct}%)`);
            this.input.setMode({ kind: 'superweapon' });
          },
        });
      }
      return { title: this.adapter.displayName(type).toUpperCase(), buttons };

    }
    return { title: '', buttons: [] };
  }

  private openBuild(): void {
    this.submenu = 'build';
    this.update(performance.now(), true);
  }

  update(now = performance.now(), force = false): void {
    if (!force && now - this.last < REFRESH_MS) return;
    this.last = now;
    const { title, buttons } = this.build();
    this.buttons = buttons;
    const key = JSON.stringify([title, buttons.map((b) => [b.id, b.key, b.badge, b.active, b.disabled, b.cost])]);
    if (key === this.key) return;
    this.key = key;
    this.title.textContent = title;
    const cells: HTMLElement[] = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      const b = buttons[i];
      if (!b) {
        cells.push(h('span', { class: 'card-cell empty' }));
        continue;
      }
      const el = h(
        'button',
        {
          class: `card-cell${b.active ? ' active' : ''}${b.disabled ? ' poor' : ''}`,
          type: 'button',
          dataset: { id: b.id },
          onclick: (e: MouseEvent) => this.trigger(b.id, e.shiftKey),
          onpointerenter: () => this.showTip(b.id),
          onpointerleave: () => this.showTip(null),
        },
        h('span', { class: 'cell-icon', html: b.icon }),
        h('span', { class: 'cell-key mono' }, keyLabel(b.key)),
        b.cost ? h('span', { class: 'cell-cost mono' }, fmtInt(b.cost)) : null,
        b.badge ? h('span', { class: 'cell-badge mono' }, b.badge) : null,
      );
      cells.push(el);
    }
    // Note the hovered cell before replacing it: the new element gets no pointerenter.
    const hovered = this.grid.querySelector<HTMLElement>('.card-cell:hover')?.dataset.id ?? null;
    setChildren(this.grid, cells);
    this.el.classList.toggle('empty', buttons.length === 0);
    this.showTip(hovered && buttons.some((b) => b.id === hovered) ? hovered : null);
  }

  private showTip(id: string | null): void {
    const b = id ? this.buttons.find((x) => x.id === id) : undefined;
    if (!b) {
      this.tip.classList.remove('show');
      return;
    }
    setChildren(
      this.tip,
      h('div', { class: 'tip-head' }, h('b', null, b.label), h('span', { class: 'keycap static' }, keyLabel(b.key))),
      b.cost ? h('div', { class: `tip-cost mono${b.disabled ? ' poor' : ''}` }, `Supply ${fmtInt(b.cost)}`) : null,
      b.detail ? h('div', { class: 'dim small' }, b.detail) : null,
    );
    this.tip.classList.add('show');
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
