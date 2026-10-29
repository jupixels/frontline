// Tiny DOM helpers. The UI is plain TS + DOM; this keeps element construction readable.

export type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null | undefined;

/**
 * `h('div', { class: 'row', onclick: fn }, 'text', child)`.
 * Props: `class`, `style` (string or object), `html` (innerHTML), `on<event>` handlers,
 * `dataset` (object); `true` sets a boolean attribute, `false`/null/undefined skip it.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else {
          for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
            if (sk.startsWith('--')) el.style.setProperty(sk, sv);
            else (el.style as unknown as Record<string, string>)[sk] = sv;
          }
        }
      } else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else if (c !== null && c !== undefined && c !== false) el.appendChild(document.createTextNode(String(c)));
  }
}

/** Replace all children of `el`. */
export function setChildren(el: HTMLElement, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  append(el, children);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** "1,234" with a thin, monospace-friendly grouping. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Seconds → "MM:SS" or "H:MM:SS". */
export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

/** Button element with the house style. */
export function button(label: Child | Child[], onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`.trim(), type: 'button', onclick }, label);
}
