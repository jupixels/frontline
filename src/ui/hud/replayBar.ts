import { SIM_HZ, type MatchSetup, type PlayerId, type Tick } from '../../shared/types';
import { fmtClock, h, setChildren } from '../dom';
import { icon } from '../icons';
import { keyLabel, type Keybinds } from '../keybinds';
import { bindTip } from '../tooltip';

/** Replay transport, implemented by the game layer (src/main.ts). */
export interface ReplayControls {
  state(): { tick: Tick; end: Tick; paused: boolean; speed: number; ended: boolean; viewAs: PlayerId };
  setPaused(p: boolean): void;
  setSpeed(s: number): void;
  /** Jump to a tick (backwards rebuilds the match and fast-forwards). */
  seek(tick: Tick): void;
  /** Watch through another player's eyes (their fog of war). */
  viewAs(player: PlayerId): void;
}

const SPEEDS = [0.5, 1, 2, 4, 8, 16];

/** Bottom bar while watching a replay: play/pause, step, scrubber, speed and perspective. */
export class ReplayBar {
  readonly el: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly time: HTMLElement;
  private readonly scrub: HTMLInputElement;
  private readonly speeds: HTMLElement;
  private readonly fill: HTMLElement;
  private dragging = false;
  private last = 0;

  constructor(
    private readonly c: ReplayControls,
    setup: MatchSetup,
    keys: () => Keybinds,
  ) {
    this.play = h('button', { class: 'rb-btn rb-play', type: 'button', onclick: () => this.toggle() });
    bindTip(this.play, () => ({ title: this.c.state().paused ? 'Play' : 'Pause', keys: [['Space', 'Play / pause']] }));
    const back = h('button', { class: 'rb-btn', type: 'button', html: icon('stepBack', 'ic-sm'), onclick: () => this.c.seek(Math.max(0, this.c.state().tick - 30 * SIM_HZ)) });
    bindTip(back, () => ({ title: 'Back 30 s', body: ['Rewinding rebuilds the match from the start and fast-forwards, so it takes a moment.'] }));
    const fwd = h('button', { class: 'rb-btn', type: 'button', html: icon('fastForward', 'ic-sm'), onclick: () => this.c.seek(Math.min(this.c.state().end, this.c.state().tick + 30 * SIM_HZ)) });
    bindTip(fwd, () => ({ title: 'Forward 30 s' }));
    this.time = h('span', { class: 'rb-time' });
    this.fill = h('span', { class: 'rb-fill' });
    this.scrub = h('input', {
      class: 'rb-scrub',
      type: 'range',
      min: 0,
      max: 1000,
      value: 0,
      'aria-label': 'Replay position',
      oninput: () => {
        this.dragging = true;
        const st = this.c.state();
        this.time.textContent = `${fmtClock(((Number(this.scrub.value) / 1000) * st.end) / SIM_HZ)} / ${fmtClock(st.end / SIM_HZ)}`;
      },
      onchange: () => {
        this.dragging = false;
        this.c.seek(Math.round((Number(this.scrub.value) / 1000) * this.c.state().end));
      },
    });
    this.speeds = h(
      'div',
      { class: 'segmented rb-speeds' },
      SPEEDS.map((s) => h('button', { type: 'button', dataset: { s: String(s) }, onclick: () => this.c.setSpeed(s) }, `${s}×`)),
    );
    bindTip(this.speeds, () => ({ title: 'Playback speed', keys: [[keyLabel(keys().gameSpeedDown), 'Slower'], [keyLabel(keys().gameSpeedUp), 'Faster']] }));
    const pov = h(
      'select',
      { class: 'select select-sm rb-pov', 'aria-label': 'Perspective', onchange: () => this.c.viewAs(Number(pov.value)) },
      setup.players.map((p) => h('option', { value: String(p.id) }, `${p.name} (T${p.team + 1})`)),
    );
    pov.value = String(c.state().viewAs);
    bindTip(pov, () => ({ title: 'Perspective', body: ["See the match through this player's eyes: their fog of war, economy and production."] }));
    this.el = h(
      'div',
      { class: 'hud-panel replay-bar' },
      h('span', { class: 'rb-tag' }, h('span', { html: icon('replay', 'ic-sm') }), 'Replay'),
      back,
      this.play,
      fwd,
      h('div', { class: 'rb-track' }, h('span', { class: 'rb-rail' }, this.fill), this.scrub),
      this.time,
      this.speeds,
      h('span', { class: 'rb-pov-wrap' }, h('span', { html: icon('eye', 'ic-sm') }), pov),
    );
    this.update(performance.now(), true);
  }

  toggle(): void {
    this.c.setPaused(!this.c.state().paused);
    this.update(performance.now(), true);
  }

  update(now = performance.now(), force = false): void {
    if (!force && now - this.last < 200) return;
    this.last = now;
    const st = this.c.state();
    const playing = !st.paused && !st.ended;
    const ic = playing ? 'pause' : 'play';
    if (this.play.dataset.ic !== ic) {
      this.play.dataset.ic = ic;
      setChildren(this.play, h('span', { html: icon(ic, 'ic-sm') }));
    }
    const frac = st.end > 0 ? Math.min(1, st.tick / st.end) : 0;
    this.fill.style.width = `${(frac * 100).toFixed(2)}%`;
    if (!this.dragging) {
      this.scrub.value = String(Math.round(frac * 1000));
      const t = `${fmtClock(st.tick / SIM_HZ)} / ${fmtClock(st.end / SIM_HZ)}${st.ended ? ' · end' : ''}`;
      if (this.time.textContent !== t) this.time.textContent = t;
    }
    for (const b of this.speeds.children) (b as HTMLElement).classList.toggle('on', Number((b as HTMLElement).dataset.s) === st.speed);
  }
}
