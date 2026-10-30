import type { MatchSetup, TeamId } from '../../shared/types';
import { h } from '../dom';
import type { MapInfo } from '../lobbyApi';
import { VICTORY_INFO } from './lobby';
import type { Screen } from './screen';

const TIPS = [
  'Power plants are high-value raid targets: low power slows production and shuts off radar.',
  'Flank tanks. Side and rear armor is much thinner than the front.',
  'Holding more strategic points than the enemy drains their Morale. At low Morale, pinned troops recover more slowly.',
  'Mobile AA keeps helicopters off your armor. Bring some before Tier 2.',
  'Shift-queue orders to chain waypoints. Right-drag sets the formation facing.',
  'Double-click a unit to select every visible unit of that type.',
  'Press Space to jump the camera to the latest alert.',
  'Artillery needs spotters. Recon jeeps see further than anything else.',
  'Ctrl+1–9 saves a control group; tap the number twice to center on it.',
];

/** Briefing card with roster and a progress bar while assets load and peers sync. */
export class LoadingScreen implements Screen {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly label: HTMLElement;
  private readonly tip: HTMLElement;
  private tipIdx = Math.floor(Math.random() * TIPS.length);
  private readonly timer: number;
  private shown = 0;
  private target = 0;
  private raf = 0;

  constructor(setup: MatchSetup, map: MapInfo | undefined, localPlayer: number) {
    this.bar = h('div', { class: 'progress-fill' });
    this.pct = h('span', { class: 'mono' }, '0%');
    this.label = h('span', { class: 'dim mono' }, 'Preparing');
    this.tip = h('p', { class: 'tip' }, TIPS[this.tipIdx]);

    const teams = new Map<TeamId, MatchSetup['players']>();
    for (const p of setup.players) {
      const t = teams.get(p.team) ?? [];
      t.push(p);
      teams.set(p.team, t);
    }
    const sides = [...teams.entries()].sort((a, b) => a[0] - b[0]);
    const roster = h(
      'div',
      { class: 'roster' },
      sides.flatMap(([team, players], i) => [
        i > 0 ? h('div', { class: 'vs mono' }, 'VS') : null,
        h(
          'div',
          { class: 'roster-side' },
          h('div', { class: 'eyebrow mono' }, `TEAM ${team + 1}`),
          players.map((p) =>
            h(
              'div',
              { class: `roster-player${p.id === localPlayer ? ' me' : ''}`, style: { '--slot-color': p.color } },
              h('span', { class: 'swatch', style: { background: p.color } }),
              h('span', null, p.name),
              p.kind === 'ai' ? h('span', { class: 'tag' }, 'AI') : null,
            ),
          ),
        ),
      ]),
    );

    this.el = h(
      'div',
      { class: 'screen loading-screen' },
      h(
        'div',
        { class: 'loading-card' },
        h('div', { class: 'eyebrow mono' }, `OPERATION · ${VICTORY_INFO[setup.victory].label.toUpperCase()}`),
        h('h2', { class: 'loading-map' }, map?.name ?? setup.mapId),
        h('div', { class: 'dim mono small' }, `${setup.players.length} players · seed ${setup.seed.toString(16).toUpperCase().padStart(8, '0')}`),
        roster,
        h('div', { class: 'progress' }, this.bar),
        h('div', { class: 'progress-meta' }, this.label, this.pct),
        this.tip,
      ),
    );
    this.timer = window.setInterval(() => {
      this.tipIdx = (this.tipIdx + 1) % TIPS.length;
      this.tip.textContent = TIPS[this.tipIdx];
    }, 6000);
    this.raf = requestAnimationFrame(() => this.animate());
  }

  /** `fraction` 0..1; the bar eases toward it. */
  setProgress(fraction: number, label?: string): void {
    this.target = Math.max(this.target, Math.min(1, Math.max(0, fraction)));
    if (label) this.label.textContent = label;
  }

  private animate(): void {
    this.shown += (this.target - this.shown) * 0.15;
    if (Math.abs(this.target - this.shown) < 0.002) this.shown = this.target;
    this.bar.style.width = `${(this.shown * 100).toFixed(1)}%`;
    this.pct.textContent = `${Math.round(this.shown * 100)}%`;
    this.raf = requestAnimationFrame(() => this.animate());
  }

  dispose(): void {
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
  }
}
