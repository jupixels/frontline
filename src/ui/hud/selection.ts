import type { Command } from '../../shared/commands';
import { SUPPRESS_PINNED, type EntityState, type SimView } from '../../shared/entities';
import type { EntityId } from '../../shared/types';
import { fmtInt, h, setChildren } from '../dom';
import { entityIcon, icon } from '../icons';
import type { InputController } from '../input';
import type { SimAdapter } from '../simAdapter';
import { bindTip } from '../tooltip';
import { maxRange, productionTip, ROLE, strongVs, threatsTo, unitName } from '../unitInfo';

const REFRESH_MS = 120;
/** Up to this many selected entities get a cell each; more are grouped by type. */
const INDIVIDUAL_MAX = 36;
const RANK = ['', 'Veteran', 'Elite', 'Hero'];
const ARMOR: Record<string, string> = { infantry: 'Infantry', light: 'Light', heavy: 'Heavy', air: 'Aircraft', naval: 'Naval', structure: 'Structure' };

function hpClass(frac: number): string {
  return frac > 0.6 ? 'hp-good' : frac > 0.3 ? 'hp-mid' : 'hp-low';
}

/**
 * Bottom-center panel. One entity: portrait, health, state (veterancy, suppression, readiness,
 * passengers, frontline), stats with counters, and the production queue for factories. Several:
 * a cell per unit (or per type for big selections); click narrows the selection, Shift+click
 * drops, Ctrl+click keeps only that type.
 */
export class SelectionPanel {
  readonly el: HTMLElement;
  private key = '';
  private last = 0;
  private mode: 'empty' | 'single' | 'multi' | '' = '';

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly input: InputController,
    private readonly issue: (cmd: Command) => void,
    private readonly hints: () => { select: string; group: string },
  ) {
    this.el = h('div', { class: 'hud-panel selection' });
  }

  update(now = performance.now(), force = false): void {
    if (!force && now - this.last < REFRESH_MS) return;
    this.last = now;
    const ents: EntityState[] = [];
    for (const id of this.input.selection) {
      const e = this.sim.get(id);
      if (e) ents.push(e);
    }
    let key = `${ents.length}`;
    if (ents.length === 1) {
      const e = ents[0];
      key += `|${e.id}:${Math.ceil(e.hp)}:${e.rank ?? 0}:${Math.round((e.suppression ?? 0) * 20)}:${e.cargo?.length ?? 0}:${e.line ?? 0}:${e.owner}:${Math.round(this.adapter.readiness(e) * 20)}`;
      if (e.kind === 'structure') key += `:${this.adapter.queue(e).map((q) => `${q.unit}${Math.round(q.progress * 50)}`).join(',')}:${Math.round((this.adapter.buildProgress(e) ?? 1) * 100)}`;
    } else {
      for (const e of ents) key += `|${e.id}:${Math.ceil((e.hp / Math.max(1, e.maxHp)) * 20)}`;
    }
    if (key === this.key && !force) return;
    this.key = key;
    if (ents.length === 0) this.renderEmpty();
    else if (ents.length === 1) this.renderSingle(ents[0]);
    else this.renderMulti(ents);
  }

  private renderEmpty(): void {
    if (this.mode === 'empty') return;
    this.mode = 'empty';
    const k = this.hints();
    setChildren(
      this.el,
      h(
        'div',
        { class: 'sel-empty' },
        h('span', { class: 'sel-empty-icon', html: icon('army', 'ic-md') }),
        h('div', null, h('div', { class: 'sel-empty-title' }, 'No selection'), h('div', { class: 'sel-empty-hint' }, 'Drag to box-select · double-click selects a type · Ctrl+1–9 saves a group')),
        h('div', { class: 'sel-empty-keys' }, h('span', null, h('span', { class: 'kbd' }, k.select), ' army'), h('span', null, h('span', { class: 'kbd' }, k.group), ' idle engineer')),
      ),
    );
  }

  private renderSingle(e: EntityState): void {
    this.mode = 'single';
    const a = this.adapter;
    const def = a.units[e.type];
    const sdef = a.structures[e.type];
    const frac = e.maxHp > 0 ? e.hp / e.maxHp : 0;
    const slot = a.slot(e.owner);
    const local = this.input.localPlayer;
    const mine = a.inArmy(local, e);
    const enemy = e.owner >= 0 && !a.isAlly(e.owner, local);
    const progress = a.buildProgress(e);
    const queue = mine ? a.queue(e) : [];

    const tags: HTMLElement[] = [];
    const rank = e.rank ?? 0;
    if (rank > 0) tags.push(h('span', { class: 'tag tag-accent' }, `${'▲'.repeat(rank)} ${RANK[rank]}${rank >= 3 ? ' · self-heal' : ''}`));
    const sup = e.suppression ?? 0;
    if (sup >= SUPPRESS_PINNED) tags.push(h('span', { class: 'tag tag-danger' }, 'Pinned · prone'));
    else if (sup > 0.15) tags.push(h('span', { class: 'tag tag-danger' }, `Suppressed ${Math.round(sup * 100)}%`));
    const ready = a.readiness(e);
    if (mine && e.kind === 'unit' && ready < 0.97) tags.push(h('span', { class: `tag ${ready < 0.75 ? 'tag-danger' : ''}` }, `Readiness ${Math.round(ready * 100)}%`));
    const cap = a.capacity(e);
    if (cap > 0) tags.push(h('span', { class: 'tag tag-info' }, `${e.kind === 'structure' ? 'Garrison' : 'Aboard'} ${e.cargo?.length ?? 0}/${cap}`));
    if (e.line) tags.push(h('span', { class: 'tag tag-ok' }, `Holding line ${e.line}`));
    if (enemy) tags.push(h('span', { class: 'tag tag-danger' }, 'Enemy'));
    else if (e.owner >= 0 && !mine) tags.push(h('span', { class: 'tag tag-info' }, 'Ally'));
    else if (e.owner < 0 && e.kind !== 'point') tags.push(h('span', { class: 'tag' }, 'Neutral'));

    const stats: [string, string][] = [];
    if (def) {
      stats.push(['Armor', ARMOR[def.armor] ?? def.armor], ['Speed', `${def.speed} m/s`], ['Range', `${maxRange(e.type)} m`], ['Sight', `${def.sight} m`]);
    } else if (sdef) {
      stats.push(['Power', `${sdef.power > 0 ? '+' : ''}${sdef.power}`]);
      if (sdef.garrison) stats.push(['Seats', String(sdef.garrison)]);
      const r = maxRange(e.type);
      if (r) stats.push(['Range', `${r} m`]);
    }
    const strong = strongVs(e.type);
    const threats = def ? threatsTo(e.type, 2) : [];

    const portrait = h('div', { class: 'sel-portrait', style: { '--team-color': slot?.color ?? '#9aa39a' } }, h('span', { html: entityIcon(e.type, def, 'ic-xl') }), rank ? h('span', { class: 'sel-rank' }, '▲'.repeat(rank)) : null);
    bindTip(portrait, () => (def || sdef ? productionTip(e.type, { supply: Infinity, icon: entityIcon(e.type, def, 'ic-md') }) : { title: unitName(e.type), body: [ROLE[e.type] ?? ''] }));

    setChildren(
      this.el,
      h(
        'div',
        { class: 'sel-single' },
        portrait,
        h(
          'div',
          { class: 'sel-info' },
          h('div', { class: 'sel-name' }, h('span', null, a.displayName(e.type)), slot && !mine ? h('span', { class: 'sel-owner', style: { color: slot.color } }, slot.name) : null),
          e.kind === 'point'
            ? h('div', { class: 'sel-role' }, ROLE.point)
            : h(
                'div',
                { class: 'hpbar' },
                h('span', { class: `hp-fill ${hpClass(frac)}`, style: { width: `${frac * 100}%` } }),
                h('span', { class: 'hp-text' }, `${fmtInt(e.hp)} / ${fmtInt(e.maxHp)}`),
              ),
          progress !== undefined && progress < 1
            ? h('div', { class: 'sel-build' }, h('span', { class: 'label' }, `Under construction · ${Math.round(progress * 100)}%`), h('div', { class: 'progress thin' }, h('div', { class: 'progress-fill', style: { width: `${progress * 100}%` } })))
            : null,
          tags.length ? h('div', { class: 'sel-tags' }, tags) : null,
          stats.length ? h('dl', { class: 'sel-stats' }, stats.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
          strong.length || threats.length
            ? h(
                'div',
                { class: 'sel-vs' },
                strong.length ? h('span', { class: 'vs-good' }, '▲ ', strong.map((x) => ARMOR[x]).join(', ')) : null,
                threats.length ? h('span', { class: 'vs-bad' }, '▼ ', threats.map(unitName).join(', ')) : null,
              )
            : null,
          e.kind !== 'point' && ROLE[e.type] && !queue.length ? h('div', { class: 'sel-role' }, ROLE[e.type]) : null,
        ),
        queue.length || (mine && a.allProduces(e.type).length && progress === undefined) ? this.queueStrip(e, queue) : null,
      ),
    );
  }

  private queueStrip(e: EntityState, queue: { unit: string; progress: number }[]): HTMLElement {
    const head = queue[0];
    return h(
      'div',
      { class: 'queue' },
      h('div', { class: 'queue-head' }, h('span', { class: 'label' }, 'Production'), h('span', { class: 'faint mono' }, `${queue.length}/10`)),
      head
        ? h(
            'button',
            { class: 'queue-now', type: 'button', title: 'Click to cancel', onclick: () => this.issue({ type: 'cancelProduce', factory: e.id, index: 0 }) },
            h('span', { html: entityIcon(head.unit, this.adapter.units[head.unit], 'ic-md') }),
            h('span', { class: 'queue-now-body' }, h('span', { class: 'queue-now-name' }, this.adapter.displayName(head.unit)), h('span', { class: 'progress thin' }, h('span', { class: 'progress-fill', style: { width: `${head.progress * 100}%`, display: 'block' } }))),
          )
        : h('div', { class: 'queue-idle' }, 'Idle: train units from the command card'),
      h(
        'div',
        { class: 'queue-items' },
        queue.slice(1, 10).map((q, i) =>
          h(
            'button',
            { class: 'queue-item', type: 'button', title: `${this.adapter.displayName(q.unit)}: click to cancel`, onclick: () => this.issue({ type: 'cancelProduce', factory: e.id, index: i + 1 }) },
            h('span', { html: entityIcon(q.unit, this.adapter.units[q.unit], 'ic-sm') }),
          ),
        ),
      ),
    );
  }

  private renderMulti(ents: EntityState[]): void {
    this.mode = 'multi';
    const a = this.adapter;
    const byType = new Map<string, EntityState[]>();
    for (const e of ents) {
      const list = byType.get(e.type) ?? [];
      list.push(e);
      byType.set(e.type, list);
    }
    const types = [...byType.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
    const hp = ents.reduce((s, e) => s + e.hp, 0);
    const max = ents.reduce((s, e) => s + e.maxHp, 0);
    const pick = (ev: MouseEvent, ids: EntityId[], type: string) => {
      if (ev.shiftKey) this.input.deselect(ids);
      else if (ev.ctrlKey || ev.metaKey) this.input.select(byType.get(type)!.map((e) => e.id));
      else this.input.select(ids);
    };
    let cells: HTMLElement[];
    if (ents.length <= INDIVIDUAL_MAX) {
      cells = types.flatMap(([type, list]) =>
        list.map((e) => {
          const f = e.maxHp > 0 ? e.hp / e.maxHp : 0;
          return h(
            'button',
            { class: `sel-unit${(e.rank ?? 0) > 0 ? ' vet' : ''}`, type: 'button', title: `${a.displayName(type)} · ${Math.round(f * 100)}%`, onclick: (ev: MouseEvent) => pick(ev, [e.id], type) },
            h('span', { html: entityIcon(type, a.units[type]) }),
            h('span', { class: 'cell-hp' }, h('span', { class: `hp-fill ${hpClass(f)}`, style: { width: `${f * 100}%` } })),
          );
        }),
      );
    } else {
      cells = types.map(([type, list]) => {
        const thp = list.reduce((s, e) => s + e.hp, 0);
        const tmax = list.reduce((s, e) => s + e.maxHp, 0);
        const f = tmax > 0 ? thp / tmax : 0;
        return h(
          'button',
          { class: 'sel-type', type: 'button', title: `${a.displayName(type)} ×${list.length}`, onclick: (ev: MouseEvent) => pick(ev, list.map((e) => e.id), type) },
          h('span', { html: entityIcon(type, a.units[type], 'ic-md') }),
          h('span', { class: 'sel-type-count' }, String(list.length)),
          h('span', { class: 'sel-type-name' }, a.displayName(type)),
          h('span', { class: 'cell-hp' }, h('span', { class: `hp-fill ${hpClass(f)}`, style: { width: `${f * 100}%` } })),
        );
      });
    }
    setChildren(
      this.el,
      h(
        'div',
        { class: 'sel-multi' },
        h(
          'div',
          { class: 'sel-multi-head' },
          h('span', { class: 'sel-count' }, `${ents.length}`, h('span', { class: 'faint' }, ' selected')),
          h('span', { class: 'sel-types' }, `${types.length} type${types.length > 1 ? 's' : ''} · ${max > 0 ? Math.round((hp / max) * 100) : 0}% health`),
          h('span', { class: 'faint small' }, 'Click: only · Shift: drop · Ctrl: type'),
        ),
        h('div', { class: `sel-grid${ents.length <= INDIVIDUAL_MAX ? ' units' : ''}` }, cells),
      ),
    );
  }
}
