import { button, h, setChildren } from '../dom';
import { icon, type IconId } from '../icons';

export interface TutorialStepView {
  index: number;
  total: number;
  icon: IconId;
  title: string;
  /** Instruction paragraphs. `[[X]]` renders X as a key cap. */
  body: string[];
  /** Short live status, e.g. "2 / 4 squads selected". */
  progress?: string;
  /** Show a Continue button (reading steps) instead of waiting for an action. */
  manual?: boolean;
  done?: boolean;
  last?: boolean;
}

/** Coach card at the top right while the tutorial runs: step, instructions, live progress. */
export class TutorialPanel {
  readonly el: HTMLElement;
  private readonly card: HTMLElement;
  private key = '';

  constructor(private readonly actions: { next(): void; skip(): void; quit(): void }) {
    this.card = h('div', { class: 'tut-card' });
    this.el = h('div', { class: 'hud-panel tutorial brackets' }, this.card);
  }

  show(s: TutorialStepView): void {
    const key = JSON.stringify(s);
    if (key === this.key) return;
    const fresh = !this.key || JSON.parse(this.key).index !== s.index;
    this.key = key;
    const dots = Array.from({ length: s.total }, (_, i) => h('span', { class: `tut-dot${i < s.index ? ' done' : i === s.index ? ' now' : ''}` }));
    setChildren(
      this.card,
      h('div', { class: 'tut-head' }, h('span', { class: 'eyebrow' }, `Basic training · ${s.index + 1} of ${s.total}`), h('span', { class: 'tut-dots' }, dots)),
      h('div', { class: 'tut-title' }, h('span', { class: `tut-icon${s.done ? ' done' : ''}`, html: icon(s.done ? 'check' : s.icon, 'ic-md') }), s.title),
      h('div', { class: 'tut-body' }, s.body.map((p) => h('p', { html: renderKeys(p) }))),
      s.progress ? h('div', { class: `tut-progress${s.done ? ' done' : ''}` }, s.progress) : null,
      h(
        'div',
        { class: 'tut-actions' },
        button('Leave training', () => this.actions.quit(), 'btn-ghost btn-sm'),
        h('span', { class: 'grow' }),
        s.manual || s.done ? button(s.last ? 'Finish training' : 'Continue', () => this.actions.next(), 'btn-accent btn-sm') : button('Skip step', () => this.actions.skip(), 'btn-ghost btn-sm'),
      ),
    );
    if (fresh) {
      this.card.classList.remove('enter');
      void this.card.offsetWidth;
      this.card.classList.add('enter');
    }
  }

  dispose(): void {
    this.el.remove();
  }
}

function renderKeys(text: string): string {
  const esc = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return esc.replace(/\[\[(.+?)\]\]/g, '<span class="kbd">$1</span>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
