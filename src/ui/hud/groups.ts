import type { SimView } from '../../shared/entities';
import { h, setChildren } from '../dom';
import { glyphFor } from '../glyphs';
import type { InputController } from '../input';
import type { SimAdapter } from '../simAdapter';

const REFRESH_MS = 200;

/** Control groups 1–9 above the selection panel: count + dominant unit type. */
export class GroupBar {
  readonly el: HTMLElement;
  private key = '';
  private last = 0;

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly input: InputController,
    private readonly onRecall: (n: number, additive: boolean, center: boolean) => void,
  ) {
    this.el = h('div', { class: 'group-bar' });
  }

  update(now = performance.now(), force = false): void {
    if (!force && now - this.last < REFRESH_MS) return;
    this.last = now;
    const sel = this.input.selection;
    const groups: { n: number; count: number; type: string; active: boolean }[] = [];
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
      groups.push({ n, count: ids.length, type, active });
    }
    const key = JSON.stringify(groups);
    if (key === this.key) return;
    this.key = key;
    setChildren(
      this.el,
      groups.map((g) =>
        h(
          'button',
          {
            class: `group${g.active ? ' active' : ''}`,
            type: 'button',
            title: `Group ${g.n} — click to select, double-click to center`,
            onclick: (e: MouseEvent) => this.onRecall(g.n, e.shiftKey, false),
            ondblclick: () => this.onRecall(g.n, false, true),
          },
          h('span', { class: 'group-n mono' }, String(g.n)),
          h('span', { class: 'group-glyph', html: glyphFor(g.type, this.adapter.units[g.type]) }),
          h('span', { class: 'group-count mono' }, String(g.count)),
        ),
      ),
    );
  }
}
