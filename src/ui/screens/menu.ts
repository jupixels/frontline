import { h } from '../dom';
import { normalizeRoomCode } from '../lobbyApi';
import type { SettingsStore } from '../settings';
import type { Screen } from './screen';

export interface MenuActions {
  host(): void;
  join(code: string): void;
  skirmish(): void;
  settings(): void;
  credits(): void;
}

const VERSION = 'v0.1.0';

/** Title screen: Play Online (Host / Join by code), Skirmish vs AI, Settings, Credits. */
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
      h('button', { class: 'menu-subitem', type: 'button', onclick: () => this.run(() => actions.host()) }, h('span', { class: 'mi-arrow' }, '›'), 'Host game', h('span', { class: 'mi-hint' }, 'get a room code')),
      h(
        'div',
        { class: 'menu-join' },
        this.codeInput,
        h('button', { class: 'btn btn-accent', type: 'button', onclick: () => this.tryJoin() }, 'Join'),
      ),
      this.joinError,
    );

    const nameInput = h('input', {
      class: 'input callsign-input',
      maxlength: 20,
      spellcheck: 'false',
      value: settings.get().playerName,
      onchange: () => settings.update({ playerName: nameInput.value }),
    });

    const item = (n: string, label: string, hint: string, onclick: () => void, extra?: HTMLElement) =>
      h(
        'div',
        { class: 'menu-group' },
        h('button', { class: 'menu-item', type: 'button', onclick }, h('span', { class: 'mi-num' }, n), h('span', { class: 'mi-label' }, label), h('span', { class: 'mi-hint' }, hint)),
        extra,
      );

    const playOnline = item('01', 'Play online', 'P2P · up to 8 players', () => this.toggleOnline(), this.online);

    this.el = h(
      'div',
      { class: 'screen menu-screen' },
      h(
        'div',
        { class: 'menu-col' },
        h(
          'header',
          { class: 'wordmark' },
          h('div', { class: 'wm-tag' }, 'OPERATIONAL'),
          h('h1', { class: 'wm-title' }, 'FRONTLINE'),
          h('div', { class: 'wm-sub' }, 'Combined arms real-time strategy'),
        ),
        h(
          'nav',
          { class: 'menu-nav' },
          playOnline,
          item('02', 'Skirmish vs AI', 'offline · easy to hard', () => this.run(() => actions.skirmish())),
          item('03', 'Settings', 'graphics · audio · keys', () => actions.settings()),
          item('04', 'Credits', 'models · sound · music', () => actions.credits()),
        ),
        h('label', { class: 'callsign' }, h('span', { class: 'label' }, 'Callsign'), nameInput),
      ),
      h(
        'aside',
        { class: 'sitrep panel' },
        h('div', { class: 'panel-title' }, h('span', null, 'SITREP'), h('span', { class: 'dim mono' }, new Date().toISOString().slice(0, 10))),
        h(
          'ul',
          { class: 'sitrep-list' },
          h('li', null, h('b', null, 'Modes'), ' 1v1 · 2v2 · 4-player FFA, rooms up to 8'),
          h('li', null, h('b', null, 'Victory'), ' Frontline tickets or Annihilation'),
          h('li', null, h('b', null, 'Netcode'), ' Peer-to-peer lockstep, no server, no install'),
          h('li', null, h('b', null, 'Invite'), ' Host, then share the room link'),
        ),
      ),
      h('footer', { class: 'menu-foot mono' }, h('span', null, `FRONTLINE ${VERSION}`), h('span', { class: 'dim' }, 'three.js · WebRTC · TypeScript')),
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
      this.joinError.textContent = 'Room codes are 6 letters/digits, like K7Q2MX';
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
