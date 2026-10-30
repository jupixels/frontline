import { button, h, setChildren } from '../dom';
import type { MatchMode } from '../lobbyApi';

/** "Waiting for <player>" banner while lockstep is stalled on a peer. */
export class WaitingOverlay {
  readonly el: HTMLElement;
  private since = 0;
  private names: string[] = [];
  private readonly text: HTMLElement;
  private readonly timer: HTMLElement;

  constructor() {
    this.text = h('span');
    this.timer = h('span', { class: 'mono dim' });
    this.el = h('div', { class: 'overlay-banner waiting hidden' }, h('span', { class: 'spinner' }), h('div', null, h('div', { class: 'eyebrow mono' }, 'CONNECTION'), this.text), this.timer);
  }

  set(names: string[]): void {
    const was = this.names.length > 0;
    this.names = names;
    if (names.length && !was) this.since = performance.now();
    this.el.classList.toggle('hidden', names.length === 0);
    this.text.textContent = names.length ? `Waiting for ${names.join(', ')}…` : '';
  }

  update(now = performance.now()): void {
    if (!this.names.length) return;
    this.timer.textContent = `${Math.floor((now - this.since) / 1000)}s`;
  }
}

/** Blocking notice when peers' state hashes diverge. */
export class DesyncOverlay {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    private readonly onQuit: () => void,
    private readonly onReport?: () => void,
  ) {
    this.body = h('div', { class: 'modal-body' });
    this.el = h('div', { class: 'overlay-modal hidden' }, h('div', { class: 'modal panel danger' }, h('div', { class: 'panel-title' }, h('span', null, 'DESYNC DETECTED')), this.body));
  }

  show(tick: number): void {
    setChildren(
      this.body,
      h('p', null, `The simulation diverged between players at tick ${tick}. The match can't continue in sync.`),
      h('p', { class: 'dim small' }, 'Saving a report helps us find the cause: it contains the command log and state hashes, no personal data.'),
      h('div', { class: 'modal-actions' }, this.onReport ? button('Save report', () => this.onReport?.(), 'btn-ghost') : null, button('Quit to menu', this.onQuit, 'btn-danger')),
    );
    this.el.classList.remove('hidden');
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
}

export interface GameMenuActions {
  resume(): void;
  settings(): void;
  surrender(): void;
  quit(): void;
}

/** F10/Esc menu: resume, settings, surrender, quit (the last two ask to confirm). */
export class GameMenu {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    private readonly mode: MatchMode,
    private readonly actions: GameMenuActions,
  ) {
    this.body = h('div', { class: 'modal-body game-menu' });
    this.el = h('div', { class: 'overlay-modal hidden' }, h('div', { class: 'modal panel narrow' }, h('div', { class: 'panel-title' }, h('span', null, this.mode === 'skirmish' ? 'PAUSED' : 'MENU')), this.body));
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) actions.resume();
    });
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(): void {
    this.main();
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  private main(): void {
    const a = this.actions;
    setChildren(
      this.body,
      this.mode === 'online' ? h('p', { class: 'dim small' }, 'The match keeps running while this menu is open.') : null,
      button('Resume', () => a.resume(), 'btn-accent btn-block'),
      button('Settings', () => a.settings(), 'btn-block'),
      button('Surrender', () => this.confirm('Surrender?', 'Your forces stand down and your team loses you as a player.', 'Surrender', () => a.surrender()), 'btn-block'),
      button('Quit to menu', () => this.confirm('Quit to menu?', this.mode === 'online' ? 'Leaving counts as a surrender for your slot.' : 'Progress in this skirmish is lost.', 'Quit', () => a.quit()), 'btn-block btn-ghost'),
    );
  }

  private confirm(title: string, detail: string, yes: string, run: () => void): void {
    setChildren(
      this.body,
      h('h3', null, title),
      h('p', { class: 'dim small' }, detail),
      h('div', { class: 'modal-actions' }, button('Cancel', () => this.main(), 'btn-ghost'), button(yes, run, 'btn-danger')),
    );
  }
}

/** Large centered banner (VICTORY / DEFEAT) shown before the results screen. */
export function outcomeBanner(text: string, cls: string): HTMLElement {
  return h('div', { class: `outcome-banner ${cls}` }, h('span', { class: 'eyebrow mono' }, 'MATCH OVER'), h('span', { class: 'outcome-text' }, text));
}
