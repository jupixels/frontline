import type { EntityState, SimView } from '../../shared/entities';
import type { EntityId, PlayerId } from '../../shared/types';
import { h, setChildren } from '../dom';
import { entityIcon, icon } from '../icons';
import type { SimAdapter } from '../simAdapter';
import { bindTip } from '../tooltip';

const REFRESH_MS = 250;
const MAX_ROWS = 9;

interface Row {
  id: EntityId;
  type: string;
  unit: string | null;
  progress: number;
  queued: number;
  constructing: number | null;
}

/**
 * Left-hand production overview: every factory of your army with what it is training, how far
 * along and how many are queued, plus buildings under construction and the superweapon charge.
 * Idle factories show too, so nothing sits unused unnoticed. Click selects, double-click centers.
 */
export class ProductionTray {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly sw: HTMLElement;
  private key = '';
  private last = 0;
  private rows: Row[] = [];

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly local: PlayerId,
    private readonly actions: { select(id: EntityId, center: boolean): void; superweapon(): void },
  ) {
    this.list = h('div', { class: 'prod-list' });
    this.sw = h('button', { class: 'prod-sw hidden', type: 'button', onclick: () => actions.superweapon() }, h('span', { html: icon('missile', 'ic-sm') }), h('span', { class: 'prod-sw-text' }), h('span', { class: 'prod-bar' }, h('span', { class: 'prod-fill' })));
    bindTip(this.sw, () => {
      const s = this.adapter.superweapon(this.adapter.armyOf(this.local));
      return { title: 'Cruise missile', sub: s?.ready ? 'Ready: click to aim' : `Charging ${Math.floor((s?.charge ?? 0) * 100)}%`, icon: icon('missile', 'ic-md'), body: ['Fired from Strategic Command. The enemy sees the target 12 s before impact.'] };
    });
    this.el = h('div', { class: 'prod-tray' }, this.list, this.sw);
  }

  update(now = performance.now()): void {
    if (now - this.last < REFRESH_MS) return;
    this.last = now;
    const a = this.adapter;
    const army = a.armyOf(this.local);
    const rows: Row[] = [];
    for (const e of this.sim.entities()) {
      if (e.kind !== 'structure' || e.owner !== army) continue;
      const building = a.buildProgress(e);
      if (building !== undefined) {
        rows.push({ id: e.id, type: e.type, unit: null, progress: building, queued: 0, constructing: building });
        continue;
      }
      if (!a.allProduces(e.type).length) continue;
      const q = a.queue(e);
      rows.push({ id: e.id, type: e.type, unit: q[0]?.unit ?? null, progress: q[0]?.progress ?? 0, queued: q.length, constructing: null });
    }
    // Busy first, then idle factories, then construction.
    rows.sort((x, y) => (x.constructing !== null ? 1 : 0) - (y.constructing !== null ? 1 : 0) || (y.unit ? 1 : 0) - (x.unit ? 1 : 0) || x.id - y.id);
    this.rows = rows.slice(0, MAX_ROWS);
    const key = this.rows.map((r) => `${r.id}:${r.unit}:${r.queued}:${r.constructing === null ? '' : 'c'}`).join('|');
    if (key !== this.key) {
      this.key = key;
      setChildren(this.list, this.rows.map((r) => this.row(r)));
    }
    this.rows.forEach((r, i) => {
      const fill = this.list.children[i]?.querySelector<HTMLElement>('.prod-fill');
      const w = `${(r.progress * 100).toFixed(1)}%`;
      if (fill && fill.style.width !== w) fill.style.width = w;
    });
    this.el.classList.toggle('hidden', !this.rows.length && this.sw.classList.contains('hidden'));

    const s = a.superweapon(army);
    this.sw.classList.toggle('hidden', !s);
    if (s) {
      this.sw.classList.toggle('ready', s.ready);
      const t = s.ready ? 'Missile ready' : `Missile ${Math.floor(s.charge * 100)}%`;
      const txt = this.sw.querySelector('.prod-sw-text')!;
      if (txt.textContent !== t) txt.textContent = t;
      (this.sw.querySelector('.prod-fill') as HTMLElement).style.width = `${(s.charge * 100).toFixed(1)}%`;
    }
  }

  private row(r: Row): HTMLElement {
    const a = this.adapter;
    const idle = r.constructing === null && !r.unit;
    const el = h(
      'button',
      {
        class: `prod-row${idle ? ' idle' : ''}${r.constructing !== null ? ' building' : ''}`,
        type: 'button',
        onclick: () => this.actions.select(r.id, false),
        ondblclick: () => this.actions.select(r.id, true),
      },
      h('span', { class: 'prod-site', html: entityIcon(r.type, undefined, 'ic-sm') }),
      r.unit ? h('span', { class: 'prod-unit', html: entityIcon(r.unit, a.units[r.unit], 'ic-sm') }) : null,
      h('span', { class: 'prod-text' }, r.constructing !== null ? 'Building' : r.unit ? (r.queued > 1 ? `+${r.queued - 1}` : '') : 'Idle'),
      h('span', { class: 'prod-bar' }, h('span', { class: 'prod-fill' })),
    );
    bindTip(el, () => {
      const e = this.sim.get(r.id) as EntityState | undefined;
      if (!e) return null;
      const q = a.queue(e);
      return {
        title: a.displayName(r.type),
        sub: r.constructing !== null ? `Under construction ${Math.round((a.buildProgress(e) ?? 1) * 100)}%` : q.length ? `Training ${a.displayName(q[0].unit)} · ${q.length} in queue` : 'Idle',
        icon: entityIcon(r.type, undefined, 'ic-md'),
        keys: [['Click', 'Select'], ['Double-click', 'Center']],
      };
    });
    return el;
  }
}
