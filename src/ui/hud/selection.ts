import type { Command } from '../../shared/commands';
import { SUPPRESS_PINNED, type EntityState, type SimView } from '../../shared/entities';
import type { EntityId } from '../../shared/types';
import { fmtInt, h, setChildren } from '../dom';
import { glyphFor } from '../glyphs';
import type { InputController } from '../input';
import type { SimAdapter } from '../simAdapter';

const REFRESH_MS = 100;

function hpClass(frac: number): string {
  return frac > 0.6 ? 'hp-good' : frac > 0.3 ? 'hp-mid' : 'hp-low';
}

/**
 * Bottom-center panel. One entity: a unit card with HP and stats (plus the production queue for
 * structures). Several: one cell per type with count and pooled HP; click a cell to narrow the
 * selection to that type, Shift+click to drop it.
 */
export class SelectionPanel {
  readonly el: HTMLElement;
  private key = '';
  private last = 0;

  constructor(
    private readonly sim: SimView,
    private readonly adapter: SimAdapter,
    private readonly input: InputController,
    private readonly issue: (cmd: Command) => void,
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
    const key = ents
      .map((e) => `${e.id}:${Math.ceil(e.hp)}:${JSON.stringify(this.adapter.queue(e))}:${this.adapter.buildProgress(e) ?? ''}:${e.rank ?? 0}:${(e.suppression ?? 0) >= SUPPRESS_PINNED}:${e.cargo?.length ?? 0}:${e.line ?? 0}:${e.owner}`)
      .join('|');
    if (key === this.key && !force) return;
    this.key = key;
    if (ents.length === 0) this.renderEmpty();
    else if (ents.length === 1) this.renderSingle(ents[0]);
    else this.renderMulti(ents);
  }

  private renderEmpty(): void {
    setChildren(
      this.el,
      h(
        'div',
        { class: 'sel-empty' },
        h('span', { class: 'eyebrow mono' }, 'NO SELECTION'),
        h('span', { class: 'dim small' }, 'Drag to select · double-click selects a type · Ctrl+1–9 saves a group'),
      ),
    );
  }

  private renderSingle(e: EntityState): void {
    const a = this.adapter;
    const def = a.units[e.type];
    const sdef = a.structures[e.type];
    const frac = e.maxHp > 0 ? e.hp / e.maxHp : 0;
    const slot = a.slot(e.owner);
    const stats: [string, string][] = [];
    if (def) {
      stats.push(['Armor', def.armor], ['Speed', `${def.speed} m/s`], ['Sight', `${def.sight} m`], ['Cost', fmtInt(def.cost)]);
    } else if (sdef) {
      stats.push(['Power', `${sdef.power > 0 ? '+' : ''}${sdef.power}`], ['Size', `${sdef.footprint * 2} m`]);
    }
    const progress = a.buildProgress(e);
    const queue = a.queue(e);
    // Phase 2 state: veterancy, suppression, passengers/garrison, frontline.
    const tags: HTMLElement[] = [];
    const rank = e.rank ?? 0;
    if (rank > 0) tags.push(h('span', { class: 'sel-tag vet' }, `VETERAN ${'▲'.repeat(rank)}${rank >= 3 ? ' · SELF-HEAL' : ''}`));
    if ((e.suppression ?? 0) >= SUPPRESS_PINNED) tags.push(h('span', { class: 'sel-tag warn' }, 'PINNED · PRONE'));
    else if ((e.suppression ?? 0) > 0.15) tags.push(h('span', { class: 'sel-tag warn' }, `SUPPRESSED ${Math.round((e.suppression ?? 0) * 100)}%`));
    const cap = a.capacity(e);
    if (cap > 0) tags.push(h('span', { class: 'sel-tag ok' }, `${e.kind === 'structure' ? 'GARRISON' : 'ABOARD'} ${e.cargo?.length ?? 0} / ${cap} SEATS`));
    if (e.line) tags.push(h('span', { class: 'sel-tag ok' }, `HOLDING LINE ${e.line}`));

    setChildren(
      this.el,
      h(
        'div',
        { class: 'sel-single' },
        h('div', { class: 'sel-portrait', style: { '--team-color': slot?.color ?? '#9aa' }, html: glyphFor(e.type, def, 'glyph glyph-lg') }),
        h(
          'div',
          { class: 'sel-info' },
          h('div', { class: 'sel-name' }, a.displayName(e.type), slot && e.owner !== this.input.localPlayer ? h('span', { class: 'tag', style: { color: slot.color } }, slot.name) : null),
          h(
            'div',
            { class: 'hpbar' },
            h('span', { class: `hp-fill ${hpClass(frac)}`, style: { width: `${frac * 100}%` } }),
            h('span', { class: 'hp-text mono' }, `${fmtInt(e.hp)} / ${fmtInt(e.maxHp)}`),
          ),
          progress !== undefined && progress < 1
            ? h('div', { class: 'build-progress' }, h('span', { class: 'dim mono small' }, `CONSTRUCTING ${Math.round(progress * 100)}%`), h('div', { class: 'progress thin' }, h('div', { class: 'progress-fill', style: { width: `${progress * 100}%` } })))
            : null,
          tags.length ? h('div', { class: 'sel-tags' }, ...tags) : null,
          h('dl', { class: 'sel-stats mono' }, stats.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        ),
        queue.length ? this.queueStrip(e, queue) : null,
      ),
    );
  }

  private queueStrip(e: EntityState, queue: { unit: string; progress: number }[]): HTMLElement {
    return h(
      'div',
      { class: 'queue' },
      h('div', { class: 'eyebrow mono' }, 'PRODUCTION'),
      h(
        'div',
        { class: 'queue-items' },
        queue.slice(0, 8).map((q, i) =>
          h(
            'button',
            {
              class: `queue-item${i === 0 ? ' active' : ''}`,
              type: 'button',
              title: `${this.adapter.displayName(q.unit)} — click to cancel`,
              onclick: () => this.issue({ type: 'cancelProduce', factory: e.id, index: i }),
            },
            h('span', { html: glyphFor(q.unit, this.adapter.units[q.unit]) }),
            i === 0 ? h('span', { class: 'queue-progress', style: { width: `${q.progress * 100}%` } }) : null,
          ),
        ),
        queue.length > 8 ? h('span', { class: 'dim mono' }, `+${queue.length - 8}`) : null,
      ),
    );
  }

  private renderMulti(ents: EntityState[]): void {
    const byType = new Map<string, EntityState[]>();
    for (const e of ents) {
      const list = byType.get(e.type) ?? [];
      list.push(e);
      byType.set(e.type, list);
    }
    const types = [...byType.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const total = ents.length;
    setChildren(
      this.el,
      h(
        'div',
        { class: 'sel-multi' },
        h('div', { class: 'sel-multi-head' }, h('span', { class: 'eyebrow mono' }, `${total} SELECTED`), h('span', { class: 'dim small' }, 'click: only this type · shift+click: remove')),
        h(
          'div',
          { class: 'sel-grid' },
          types.map(([type, list]) => {
            const hp = list.reduce((s, e) => s + e.hp, 0);
            const max = list.reduce((s, e) => s + e.maxHp, 0);
            const frac = max > 0 ? hp / max : 0;
            const ids: EntityId[] = list.map((e) => e.id);
            return h(
              'button',
              {
                class: 'sel-cell',
                type: 'button',
                title: `${this.adapter.displayName(type)} ×${list.length}`,
                onclick: (ev: MouseEvent) => {
                  if (ev.shiftKey) this.input.deselect(ids);
                  else this.input.select(ids);
                },
              },
              h('span', { class: 'cell-glyph', html: glyphFor(type, this.adapter.units[type]) }),
              h('span', { class: 'cell-count mono' }, String(list.length)),
              h('span', { class: 'cell-name' }, this.adapter.displayName(type)),
              h('span', { class: 'cell-hp' }, h('span', { class: `hp-fill ${hpClass(frac)}`, style: { width: `${frac * 100}%` } })),
            );
          }),
        ),
      ),
    );
  }
}
