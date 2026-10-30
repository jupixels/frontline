import type { SimView } from '../../shared/entities';
import { h, setChildren } from '../dom';
import { entityIcon, icon } from '../icons';
import type { InputController } from '../input';
import { keyLabel, type Keybinds } from '../keybinds';
import type { SimAdapter } from '../simAdapter';
import { bindTip } from '../tooltip';

const REFRESH_MS = 250;

export interface QuickCounts {
  army: number;
  idleEngineers: number;
}

/**
 * Strip above the selection panel: quick buttons (whole army, next idle engineer) and control
 * groups 1–9 with their main unit type and size.
 */
export class GroupBar {
  readonly el: HTMLElement;
  private readonly quick: HTMLElement;
  private readonly groups: HTMLElement;
  private readonly armyBtn: HTMLButtonElement;
  private readonly idleBtn: HTMLButtonElement;
  private key = '';
  private last = 0;

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly input: InputController,
    private readonly keybinds: () => Keybinds,
    private readonly counts: () => QuickCounts,
    private readonly actions: { army(): void; idle(): void; recall(n: number, additive: boolean, center: boolean): void },
  ) {
    this.armyBtn = h('button', { class: 'quick-btn', type: 'button', onclick: () => actions.army() }, h('span', { html: icon('army', 'ic-sm') }), h('span', { class: 'quick-n' }, '0'));
    bindTip(this.armyBtn, () => ({ title: 'Select army', sub: `${this.counts().army} combat units`, body: ['Every combat unit you command (engineers and trucks excluded).'], keys: [[keyLabel(keybinds().selectArmy), 'Select army']] }));
    this.idleBtn = h('button', { class: 'quick-btn idle', type: 'button', onclick: () => actions.idle() }, h('span', { html: entityIcon('engineer', undefined, 'ic-sm') }), h('span', { class: 'quick-n' }, '0'));
    bindTip(this.idleBtn, () => ({ title: 'Idle engineers', sub: `${this.counts().idleEngineers} with nothing to do`, body: ['Selects the next idle engineer and centers the camera on it.'], keys: [[keyLabel(keybinds().idleEngineer), 'Next idle engineer']] }));
    this.quick = h('div', { class: 'quick' }, this.armyBtn, this.idleBtn);
    this.groups = h('div', { class: 'groups' });
    this.el = h('div', { class: 'group-bar' }, this.quick, this.groups);
  }

  update(now = performance.now(), force = false): void {
    if (!force && now - this.last < REFRESH_MS) return;
    this.last = now;
    const c = this.counts();
    const setN = (b: HTMLElement, n: number) => {
      const t = String(n);
      const el = b.querySelector('.quick-n')!;
      if (el.textContent !== t) el.textContent = t;
    };
    setN(this.armyBtn, c.army);
    setN(this.idleBtn, c.idleEngineers);
    this.idleBtn.classList.toggle('alert', c.idleEngineers > 0);
    this.idleBtn.disabled = c.idleEngineers === 0;
    this.armyBtn.disabled = c.army === 0;

    const sel = this.input.selection;
    const k = this.keybinds();
    const groups: { n: number; count: number; type: string; active: boolean; key: string }[] = [];
    for (let n = 1; n <= 9; n++) {
      const ids = (this.input.groups.get(n) ?? []).filter((id) => this.sim.get(id));
      if (!ids.length) continue;
      const counts = new Map<string, number>();
      for (const id of ids) {
        const t = this.sim.get(id)!.type;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const type = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const active = ids.length === sel.size && ids.every((id) => sel.has(id));
      groups.push({ n, count: ids.length, type, active, key: keyLabel(k[`group${n}` as keyof Keybinds]) });
    }
    const key = JSON.stringify(groups);
    if (key === this.key) return;
    this.key = key;
    setChildren(
      this.groups,
      groups.map((g) => {
        const el = h(
          'button',
          {
            class: `group${g.active ? ' active' : ''}`,
            type: 'button',
            onclick: (e: MouseEvent) => this.actions.recall(g.n, e.shiftKey, false),
            ondblclick: () => this.actions.recall(g.n, false, true),
          },
          h('span', { class: 'group-n' }, g.key),
          h('span', { html: entityIcon(g.type, this.adapter.units[g.type], 'ic-sm') }),
          h('span', { class: 'group-count' }, String(g.count)),
        );
        bindTip(el, () => ({ title: `Group ${g.n}`, sub: `${g.count} × mostly ${this.adapter.displayName(g.type)}`, keys: [[g.key, 'Select'], [`${g.key} ${g.key}`, 'Center'], [`Ctrl+${g.key}`, 'Save'], [`Shift+${g.key}`, 'Add']] }));
        return el;
      }),
    );
  }
}
