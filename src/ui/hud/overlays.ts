import { button, h, setChildren } from '../dom';
import { entityIcon } from '../icons';
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
    this.el = h('div', { class: 'overlay-modal hidden' }, h('div', { class: 'modal panel narrow' }, h('div', { class: 'panel-title' }, h('span', null, this.mode === 'online' ? 'Menu' : 'Paused')), this.body));
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
      button('Quit to menu', () => this.confirm('Quit to menu?', this.mode === 'online' ? 'Leaving counts as a surrender for your slot.' : this.mode === 'replay' ? 'Stop watching this replay.' : 'Progress in this match is lost.', 'Quit', () => a.quit()), 'btn-block btn-ghost'),
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

export interface ManualContext {
  keys: Record<string, string>;
}

/** F1 field manual: controls (live keybinds), how Morale wins, the economy and the counter wheel. */
export class FieldManual {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private tab = 0;

  constructor(
    private readonly ctx: () => ManualContext,
    private readonly onClose: () => void,
  ) {
    this.body = h('div', { class: 'manual-body' });
    this.el = h(
      'div',
      { class: 'overlay-modal hidden' },
      h('div', { class: 'modal panel manual brackets' }, h('div', { class: 'panel-title' }, h('span', null, 'Field manual'), button('Close', () => this.onClose(), 'btn-ghost btn-sm')), this.body),
    );
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.onClose();
    });
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(): void {
    this.render();
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  private render(): void {
    const k = this.ctx().keys;
    const tabs = ['Controls', 'Winning', 'Economy', 'Counters'];
    const kb = (label: string, key: string) => h('div', { class: 'man-key' }, h('span', null, label), h('span', { class: 'kbd' }, key));
    const pages: (() => HTMLElement)[] = [
      () =>
        h(
          'div',
          { class: 'man-cols' },
          h('section', null, h('h4', null, 'Mouse'), kb('Select / box select', 'Left'), kb('Move · attack · rally', 'Right'), kb('Formation facing', 'Right-drag'), kb('Select all of a type', 'Double-click'), kb('Rotate camera', 'Middle-drag'), kb('Zoom', 'Wheel')),
          h('section', null, h('h4', null, 'Orders'), kb('Attack-move', k.attackMove), kb('Stop', k.stop), kb('Hold position', k.hold), kb('Patrol', k.patrol), kb('Build menu', k.build), kb('Board / garrison', k.enter), kb('Unload', k.unload), kb('Draw frontline (hold, drag)', k.drawLine), kb('Queue any order', 'Shift')),
          h('section', null, h('h4', null, 'Camera & army'), kb('Pan', `${k.panUp}${k.panLeft}${k.panDown}${k.panRight}`), kb('Select army', k.selectArmy), kb('Next idle engineer', k.idleEngineer), kb('Jump to HQ', k.jumpBase), kb('Jump to last alert', k.jumpAlert), kb('Center on selection', k.centerSelection), kb('Save / recall group', `Ctrl+${k.group1} · ${k.group1}`)),
        ),
      () =>
        h(
          'div',
          { class: 'man-text' },
          h('p', null, h('b', null, 'Morale. '), 'Each side starts with 1,000 Morale. Whoever holds fewer strategic points than the leader loses Morale every second; units lost cost a little more. At zero a side breaks and loses. Destroying the enemy HQ also wins.'),
          h('p', null, h('b', null, 'Shaken. '), 'Below 25% a side is shaken: its pinned troops recover slowly. Both sides are told.'),
          h('p', null, h('b', null, 'Points. '), 'Stand ground units on a point to capture it. An enemy point must be neutralized first. The diamonds in the top bar show every point; click one to look at it.'),
          h('p', null, h('b', null, 'Frontlines. '), `Select units, hold ${k.drawLine} and drag a line. They spread along it by role and hold it: infantry seek cover, AT teams take the flanks, tanks stay behind, artillery far back. Advance the line with ${k.advanceLine}.`),
          h('p', null, h('b', null, 'Sudden death. '), 'At 90 minutes HQs lose their armor and every side bleeds, so every match ends.'),
        ),
      () =>
        h(
          'div',
          { class: 'man-text' },
          h('p', null, h('b', null, 'Supply '), 'pays for everything. Your HQ earns some; held points and Supply Depots earn more. Supply trucks carry it home, so cutting their routes starves the enemy.'),
          h('p', null, h('b', null, 'Power '), 'comes from Power Plants. Short on power, production runs at half speed and radar and defenses go dark.'),
          h('p', null, h('b', null, 'Command points '), 'cap your army size. Holding points raises the cap; a side that is behind gets a little extra.'),
          h('p', null, h('b', null, 'Tiers. '), 'A Radar Station unlocks Tier 2 (tanks, artillery, helicopters, most ships). Strategic Command unlocks Tier 3 (jets, bombers, cruisers) and the cruise missile.'),
          h('p', null, h('b', null, 'Readiness. '), 'Units far from friendly supply slowly lose fire rate and accuracy.'),
        ),
      () => {
        const pair = (a: string, b: string, text: string) => h('div', { class: 'man-counter' }, h('span', { html: entityIcon(a, undefined, 'ic-md') }), h('span', { class: 'man-arrow' }, '›'), h('span', { html: entityIcon(b, undefined, 'ic-md') }), h('span', null, text));
        return h(
          'div',
          { class: 'man-counters' },
          pair('sniper', 'rifleman', 'Snipers and machine guns pin infantry'),
          pair('at_soldier', 'tank_mbt', 'AT teams ambush tanks'),
          pair('tank_mbt', 'scout_car', 'Tanks crush light vehicles and infantry'),
          pair('artillery', 'trench', 'Artillery breaks static and clumped targets'),
          pair('heli_attack', 'tank_light', 'Attack helicopters hunt armor'),
          pair('aa_tank', 'heli_attack', 'Mobile AA shreds helicopters'),
          pair('jet_fighter', 'heli_transport', 'Fighters rule the air'),
          pair('destroyer', 'submarine', 'Destroyers hunt subs and boats'),
          pair('submarine', 'cruiser', 'Subs sink capital ships'),
          pair('cruiser', 'hq', 'Capital ships bombard the shore'),
        );
      },
    ];
    setChildren(
      this.body,
      h('div', { class: 'segmented' }, tabs.map((t, i) => h('button', { class: i === this.tab ? 'on' : '', type: 'button', onclick: () => ((this.tab = i), this.render()) }, t))),
      pages[this.tab](),
    );
  }
}
