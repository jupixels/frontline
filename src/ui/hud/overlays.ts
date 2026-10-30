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

/** Online pause state: who paused, a resume button, or the pending vote count. */
export class PauseOverlay {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private paused = false;

  constructor(private readonly vote: (paused: boolean) => void) {
    this.text = h('div');
    this.sub = h('div', { class: 'dim small mono' });
    this.btn = button('Resume', () => this.vote(!this.paused), 'btn-accent') as HTMLButtonElement;
    this.el = h('div', { class: 'overlay-banner pause hidden' }, h('div', null, h('div', { class: 'eyebrow mono' }, 'PAUSE'), this.text, this.sub), this.btn);
  }

  /** `paused` with who did it, or a vote in progress (`votes` of `needed`), or nothing. */
  set(s: { paused: boolean; by?: string; votes: number; needed: number; mine: boolean; left: number } | null): void {
    if (!s || (!s.paused && s.votes === 0)) {
      this.el.classList.add('hidden');
      this.paused = false;
      return;
    }
    this.paused = s.paused;
    this.el.classList.remove('hidden');
    if (s.paused) {
      this.text.textContent = `Game paused${s.by ? ` by ${s.by}` : ''}`;
      this.sub.textContent = 'Anyone can resume after 3 s · resumes by itself after 90 s';
      this.btn.textContent = 'Resume';
      this.btn.disabled = false;
    } else {
      this.text.textContent = `Pause vote: ${s.votes} / ${s.needed}`;
      this.sub.textContent = s.mine ? 'Waiting for the other players to agree…' : `You have ${s.left} pause${s.left === 1 ? '' : 's'} left`;
      this.btn.textContent = s.mine ? 'Withdraw' : 'Agree';
      this.btn.disabled = false;
      if (s.mine) this.paused = true; // clicking withdraws (votes false)
    }
  }
}

/** Big red countdown when a cruise missile is inbound (everyone sees it: that's the early warning). */
export class StrikeWarning {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private strikes: { arrive: number; own: boolean; jump: () => void }[] = [];

  constructor() {
    this.text = h('span', { class: 'mono' });
    this.el = h('div', { class: 'overlay-banner strike hidden' }, h('div', null, h('div', { class: 'eyebrow mono' }, 'STRATEGIC STRIKE'), this.text));
    this.el.addEventListener('click', () => this.strikes[0]?.jump());
  }

  add(arriveAtMs: number, own: boolean, jump: () => void): void {
    this.strikes.push({ arrive: arriveAtMs, own, jump });
  }

  update(now = performance.now()): void {
    this.strikes = this.strikes.filter((s) => s.arrive > now - 1500);
    this.el.classList.toggle('hidden', !this.strikes.length);
    const s = this.strikes[0];
    if (!s) return;
    const left = Math.max(0, (s.arrive - now) / 1000);
    this.el.classList.toggle('own', s.own);
    this.text.textContent = left > 0 ? `${s.own ? 'Our cruise missile' : 'Incoming cruise missile'} — impact in ${left.toFixed(1)} s (click to view)` : 'Impact';
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
  /** Online: ask the other players to pause. */
  pauseVote?(): void;
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
      this.mode === 'online' && a.pauseVote ? button('Vote to pause', () => a.pauseVote?.(), 'btn-block') : null,
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
