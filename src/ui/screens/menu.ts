import { h } from '../dom';
import { icon, type IconId } from '../icons';
import { normalizeRoomCode } from '../lobbyApi';
import { loadRecord, ACHIEVEMENTS } from '../records';
import type { SettingsStore } from '../settings';
import type { Screen } from './screen';

export interface MenuActions {
  host(): void;
  join(code: string): void;
  skirmish(): void;
  tutorial(): void;
  replays(): void;
  record(): void;
  settings(): void;
  credits(): void;
}

const VERSION = 'v0.3.0';

/** Title screen: play (tutorial, skirmish, online host/join), replays, service record, settings, credits. */
export class MenuScreen implements Screen {
  readonly el: HTMLElement;
  private readonly online: HTMLElement;
  private readonly codeInput: HTMLInputElement;
  private readonly joinError: HTMLElement;
  private busy = false;

  constructor(
    private readonly actions: MenuActions,
    private readonly settings: SettingsStore,
    initialCode = '',
  ) {
    this.codeInput = h('input', {
      class: 'input code-input',
      placeholder: 'ROOM CODE',
      maxlength: 9,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Room code',
      value: initialCode,
      oninput: () => {
        this.codeInput.value = this.codeInput.value.toUpperCase();
        this.joinError.textContent = '';
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.tryJoin();
      },
    });
    this.joinError = h('div', { class: 'field-error' });

    this.online = h(
      'div',
      { class: 'menu-sub' },
      h(
        'button',
        { class: 'menu-subitem', type: 'button', onclick: () => this.run(() => actions.host()) },
        h('span', { html: icon('plus', 'ic-sm') }),
        h('span', null, 'Host a game'),
        h('span', { class: 'mi-hint' }, 'get a room code to share'),
      ),
      h('div', { class: 'menu-join' }, this.codeInput, h('button', { class: 'btn btn-accent', type: 'button', onclick: () => this.tryJoin() }, 'Join')),
      this.joinError,
    );

    const nameInput = h('input', {
      class: 'input callsign-input',
      maxlength: 20,
      spellcheck: 'false',
      'aria-label': 'Callsign',
      value: settings.get().playerName,
      onchange: () => settings.update({ playerName: nameInput.value }),
    });

    const item = (ic: IconId, label: string, hint: string, onclick: () => void, extra?: HTMLElement, primary = false) =>
      h(
        'div',
        { class: `menu-group${primary ? ' primary' : ''}` },
        h(
          'button',
          { class: 'menu-item', type: 'button', onclick },
          h('span', { class: 'mi-icon', html: icon(ic) }),
          h('span', { class: 'mi-body' }, h('span', { class: 'mi-label' }, label), h('span', { class: 'mi-hint' }, hint)),
          h('span', { class: 'mi-arrow', html: icon('back', 'ic-sm') }),
        ),
        extra,
      );

    const rec = loadRecord();
    const unlocked = ACHIEVEMENTS.filter((a) => rec.achievements[a.id]).length;
    const firstVisit = rec.matches === 0 && !rec.tutorialDone;

    this.el = h(
      'div',
      { class: 'screen menu-screen' },
      h(
        'div',
        { class: 'menu-col' },
        h(
          'header',
          { class: 'wordmark' },
          h('div', { class: 'wm-tag' }, 'Combined arms · real-time strategy'),
          h('h1', { class: 'wm-title' }, 'Frontline'),
          h('div', { class: 'wm-sub' }, 'Hold the line. Break their Morale.'),
        ),
        h(
          'nav',
          { class: 'menu-nav' },
          item('tutorial', 'Basic training', firstVisit ? 'new here? start with this · 10 min' : 'camera, orders, building, Morale, frontlines', () => this.run(() => actions.tutorial()), undefined, firstVisit),
          item('army', 'Skirmish', 'vs AI · easy to hard · up to 8 sides', () => this.run(() => actions.skirmish()), undefined, !firstVisit),
          item('globe', 'Play online', 'peer to peer · co-op or versus', () => this.toggleOnline(), this.online),
          item('replay', 'Replays', 'watch a saved match', () => actions.replays()),
          item('medal', 'Service record', rec.matches ? `${rec.wins}/${rec.matches} won · ${unlocked}/${ACHIEVEMENTS.length} medals` : 'stats and medals', () => actions.record()),
          item('gear', 'Settings', 'graphics · audio · controls · accessibility', () => actions.settings()),
          item('credits', 'Credits', 'models · sound · music', () => actions.credits()),
        ),
        h('label', { class: 'callsign' }, h('span', { class: 'label' }, 'Callsign'), nameInput),
      ),
      h(
        'aside',
        { class: 'menu-side' },
        h(
          'section',
          { class: 'panel sitrep brackets' },
          h('div', { class: 'panel-title' }, h('span', null, 'Sitrep'), h('span', { class: 'dim' }, VERSION)),
          h(
            'ul',
            { class: 'sitrep-list' },
            sitrep('point', 'Victory', 'Hold more strategic points than the enemy to drain their Morale. At zero, they break.'),
            sitrep('line', 'Frontlines', 'Draw a line and your units hold it by role: infantry in cover, AT on the flanks, armor behind.'),
            sitrep('team', 'Co-op', 'Shared command: two or more players run one army, optionally split into ground, air, navy and logistics.'),
            sitrep('link', 'Invite', 'Host a game and share the link. No install, no account, no server.'),
          ),
        ),
      ),
      h('footer', { class: 'menu-foot' }, h('span', null, `Frontline ${VERSION}`), h('span', { class: 'faint' }, 'three.js · WebRTC · TypeScript')),
    );

    if (initialCode) this.toggleOnline(true);
  }

  private toggleOnline(force?: boolean): void {
    const open = force ?? !this.online.classList.contains('open');
    this.online.classList.toggle('open', open);
    this.online.parentElement?.classList.toggle('expanded', open);
    if (open) setTimeout(() => this.codeInput.focus(), 50);
  }

  private tryJoin(): void {
    const code = normalizeRoomCode(this.codeInput.value);
    if (!code) {
      this.joinError.textContent = 'Room codes are 6 letters or digits, like K7Q2MX';
      return;
    }
    this.run(() => this.actions.join(code));
  }

  private run(fn: () => void): void {
    if (this.busy) return;
    this.busy = true;
    setTimeout(() => (this.busy = false), 600);
    fn();
  }

  showJoinError(msg: string): void {
    this.toggleOnline(true);
    this.joinError.textContent = msg;
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.online.classList.contains('open')) {
      this.toggleOnline(false);
      return true;
    }
    return false;
  }

  dispose(): void {
    // Keep a name typed but not yet committed with blur.
    const input = this.el.querySelector<HTMLInputElement>('.callsign-input');
    if (input && input.value.trim() && input.value !== this.settings.get().playerName) this.settings.update({ playerName: input.value });
  }
}

function sitrep(ic: IconId, title: string, text: string): HTMLElement {
  return h('li', null, h('span', { class: 'sr-icon', html: icon(ic, 'ic-sm') }), h('div', null, h('b', null, title), h('span', null, text)));
}
