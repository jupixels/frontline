import type { Vec2 } from '../../shared/types';
import { h } from '../dom';
import { ICONS } from '../glyphs';

export type AlertKind = 'attack' | 'capture' | 'lost' | 'ready' | 'info' | 'warn';

export interface Alert {
  kind: AlertKind;
  text: string;
  pos?: Vec2;
}

interface Live extends Alert {
  el: HTMLElement;
  born: number;
}

const LIFE_MS = 9000;
const MAX_SHOWN = 5;

/** Left-side feed of recent alerts. Space jumps to the newest one with a position, then older ones. */
export class AlertFeed {
  readonly el: HTMLElement;
  private live: Live[] = [];
  private history: Alert[] = [];
  private cursor = -1;
  private lastJump = 0;

  constructor(private readonly onJump: (pos: Vec2) => void) {
    this.el = h('div', { class: 'alert-feed' });
  }

  push(a: Alert): void {
    const el = h(
      'div',
      { class: `alert ${a.kind}${a.pos ? ' jumpable' : ''}`, onclick: () => a.pos && this.onJump(a.pos) },
      h('span', { class: 'alert-icon', html: a.kind === 'capture' ? ICONS.flag : a.kind === 'ready' ? ICONS.cp : ICONS.alert }),
      h('span', { class: 'alert-text' }, a.text),
      a.pos ? h('span', { class: 'alert-key mono' }, 'SPACE') : null,
    );
    // Only the newest jumpable alert advertises the Space key.
    if (a.pos) for (const l of this.live) l.el.querySelector('.alert-key')?.remove();
    this.el.appendChild(el);
    this.live.push({ ...a, el, born: performance.now() });
    while (this.live.length > MAX_SHOWN) this.live.shift()!.el.remove();
    if (a.pos) {
      this.history.push(a);
      if (this.history.length > 20) this.history.shift();
      this.cursor = -1;
    }
  }

  /** Space: newest alert first; pressing again within 2 s walks back through older ones. */
  jump(): boolean {
    if (!this.history.length) return false;
    const now = performance.now();
    this.cursor = now - this.lastJump < 2000 ? this.cursor + 1 : 0;
    if (this.cursor >= this.history.length) this.cursor = 0;
    this.lastJump = now;
    const a = this.history[this.history.length - 1 - this.cursor];
    if (a.pos) this.onJump(a.pos);
    return true;
  }

  update(now = performance.now()): void {
    for (const l of this.live) {
      const age = now - l.born;
      if (age > LIFE_MS) l.el.classList.add('gone');
    }
    const keep: Live[] = [];
    for (const l of this.live) {
      if (now - l.born > LIFE_MS + 600) l.el.remove();
      else keep.push(l);
    }
    this.live = keep;
  }
}
