import { h, setChildren, type Child } from './dom';

/** What a tooltip shows. Built lazily on hover, so it can read live state (cooldowns, supply). */
export interface TipContent {
  title: string;
  /** Small line under the title (role, owner). */
  sub?: string;
  /** Inline SVG shown left of the title. */
  icon?: string;
  costs?: { kind: 'supply' | 'power' | 'cp' | 'time' | 'tier'; text: string; poor?: boolean }[];
  /** Paragraphs or prepared nodes. */
  body?: (string | Node)[];
  /** Label → value rows, e.g. strong/weak against. `cls` colors the value. */
  rows?: { k: string; v: string; cls?: 'good' | 'bad' }[];
  /** Hotkey hints: [key label, action]. */
  keys?: [string, string][];
  /** Red line (not enough supply, recharging...). */
  warn?: string;
}

const ICON_FOR: Record<string, string> = {
  supply: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 2.4 L21 6.8 V17.2 L12 21.6 L3 17.2 V6.8 Z"/></svg>',
  power: '<svg class="ic" viewBox="0 0 24 24"><path d="M13.6 1.8 L4.8 13.6 H10.8 L9.4 22.2 L19.2 9.6 H13.2 Z"/></svg>',
  cp: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 2.2 L14.7 8.5 L21.5 9.1 L16.3 13.6 L17.9 20.2 L12 16.6 L6.1 20.2 L7.7 13.6 L2.5 9.1 L9.3 8.5 Z"/></svg>',
  time: '<svg class="ic" viewBox="0 0 24 24"><path class="s" d="M12 3.4 A8.6 8.6 0 1 1 11.99 3.4 Z M12 7.4 V12 L15.2 14.2"/></svg>',
  tier: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 2.6 L20.6 8.8 V12 L12 5.8 L3.4 12 V8.8 Z M12 9.6 L20.6 15.8 V19 L12 12.8 L3.4 19 V15.8 Z"/></svg>',
};

const SHOW_DELAY_MS = 260;
const SWITCH_DELAY_MS = 40;

/**
 * One floating tooltip for the whole UI. Elements opt in with `bindTip(el, () => content)`; the
 * content function runs only when the tip opens or refreshes, so hovering costs nothing per frame.
 */
class TooltipHost {
  private el: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private source: (() => TipContent | null) | null = null;
  private timer = 0;
  private refresh = 0;
  private openAt = 0;
  enabled = true;

  private ensure(): HTMLElement {
    if (!this.el) {
      this.el = h('div', { class: 'tooltip', role: 'tooltip' });
      document.body.appendChild(this.el);
    }
    return this.el;
  }

  enter(anchor: HTMLElement, source: () => TipContent | null): void {
    clearTimeout(this.timer);
    const quick = performance.now() - this.openAt < 400 || this.el?.classList.contains('show');
    this.timer = window.setTimeout(() => this.open(anchor, source), quick ? SWITCH_DELAY_MS : SHOW_DELAY_MS);
  }

  leave(anchor: HTMLElement): void {
    clearTimeout(this.timer);
    if (this.anchor !== anchor) return;
    this.hide();
  }

  hide(): void {
    clearTimeout(this.timer);
    clearInterval(this.refresh);
    if (this.el?.classList.contains('show')) this.openAt = performance.now();
    this.el?.classList.remove('show');
    this.anchor = null;
    this.source = null;
  }

  private open(anchor: HTMLElement, source: () => TipContent | null): void {
    if (!this.enabled || !anchor.isConnected) return;
    this.anchor = anchor;
    this.source = source;
    if (!this.render()) return;
    this.place();
    this.el!.classList.add('show');
    clearInterval(this.refresh);
    // Live values (cooldowns, supply) refresh while the tip is open.
    this.refresh = window.setInterval(() => {
      if (!this.anchor?.isConnected) return this.hide();
      this.render();
    }, 250);
  }

  private render(): boolean {
    const c = this.source?.();
    const el = this.ensure();
    if (!c) {
      this.hide();
      return false;
    }
    setChildren(el, renderTip(c));
    return true;
  }

  private place(): void {
    const el = this.el!;
    const a = this.anchor!.getBoundingClientRect();
    const scale = Number(getComputedStyle(el).zoom) || 1;
    const w = el.offsetWidth * scale;
    const ht = el.offsetHeight * scale;
    const gap = 10;
    let x = a.left + a.width / 2 - w / 2;
    let y = a.top - ht - gap;
    if (y < 8) y = a.bottom + gap;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    y = Math.max(8, Math.min(innerHeight - ht - 8, y));
    el.style.left = `${x / scale}px`;
    el.style.top = `${y / scale}px`;
  }
}

export const tooltip = new TooltipHost();

export function renderTip(c: TipContent): Child[] {
  const out: Child[] = [];
  out.push(
    h(
      'div',
      { class: 'tt-head' },
      c.icon ? h('span', { html: c.icon }) : null,
      h('div', { class: 'tt-title' }, c.title, c.sub ? h('span', { class: 'tt-sub' }, c.sub) : null),
    ),
  );
  if (c.costs?.length) {
    out.push(
      h(
        'div',
        { class: 'tt-costs' },
        c.costs.map((k) => h('span', { class: `tt-cost ${k.kind}${k.poor ? ' poor' : ''}` }, h('span', { html: ICON_FOR[k.kind] ?? '' }), k.text)),
      ),
    );
  }
  if (c.body?.length) out.push(h('div', { class: 'tt-body' }, c.body.map((b) => (typeof b === 'string' ? h('p', null, b) : b))));
  if (c.rows?.length) out.push(h('dl', { class: 'tt-vs' }, c.rows.flatMap((r) => [h('dt', null, r.k), h('dd', { class: r.cls ?? '' }, r.v)])));
  if (c.warn) out.push(h('div', { class: 'tt-warn' }, c.warn));
  if (c.keys?.length) out.push(h('div', { class: 'tt-foot' }, c.keys.map(([k, what]) => h('span', null, h('span', { class: 'kbd' }, k), what))));
  return out;
}

/** Attach a tooltip to `el`. Returns `el` for chaining inside `h(...)` trees. */
export function bindTip<T extends HTMLElement>(el: T, source: () => TipContent | null): T {
  el.addEventListener('pointerenter', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    tooltip.enter(el, source);
  });
  el.addEventListener('pointerleave', () => tooltip.leave(el));
  el.addEventListener('pointerdown', () => tooltip.hide());
  return el;
}

/** Simple text tooltip. */
export function tipText(el: HTMLElement, title: string, body?: string, keys?: [string, string][]): HTMLElement {
  return bindTip(el, () => ({ title, body: body ? [body] : undefined, keys }));
}
