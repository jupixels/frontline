import type { MatchSetup, PlayerId, TeamId } from '../../shared/types';
import { button, fmtClock, fmtInt, h, setChildren } from '../dom';
import type { StatSample } from '../hud/stats';
import { icon } from '../icons';
import type { Achievement, MatchFacts } from '../records';
import type { Screen } from './screen';

export interface PlayerStats {
  player: PlayerId;
  unitsProduced: number;
  unitsLost: number;
  kills: number;
  structuresBuilt: number;
  damageDealt: number;
  pointsCaptured: number;
}

export interface MatchResult {
  setup: MatchSetup;
  localPlayer: PlayerId;
  /** null = draw / abandoned. */
  winnerTeam: TeamId | null;
  durationSec: number;
  stats: PlayerStats[];
  /** Short line, e.g. "Enemy HQ destroyed", "Morale broken", "Surrendered". */
  reason?: string;
  /** Sampled every 10 s of game time, for the graphs. */
  timeline?: StatSample[];
  /** Local side's deeds, for medals. */
  facts?: MatchFacts;
  mode?: string;
  mapName?: string;
}

export interface ResultsExtras {
  newMedals?: Achievement[];
  /** Download the match's replay file. */
  saveReplay?(): void;
  /** Watch this match again from the start. */
  watchReplay?(): void;
}

type Metric = 'morale' | 'army' | 'points' | 'kills';
const METRICS: { id: Metric; label: string; detail: string }[] = [
  { id: 'morale', label: 'Morale', detail: 'Team Morale over time. The side that hits zero breaks.' },
  { id: 'army', label: 'Army value', detail: 'Supply cost of every living unit, per player.' },
  { id: 'points', label: 'Points held', detail: 'Strategic points each player held.' },
  { id: 'kills', label: 'Kills', detail: 'Enemy units and structures destroyed, cumulative.' },
];

/** Post-match debrief: outcome, the match graphed over time, per-player table and medals. */
export class ResultsScreen implements Screen {
  readonly el: HTMLElement;
  private metric: Metric = 'morale';
  private readonly chart: HTMLElement;

  constructor(
    private readonly r: MatchResult,
    onContinue: () => void,
    extras: ResultsExtras = {},
  ) {
    const me = r.setup.players.find((p) => p.id === r.localPlayer);
    const won = r.winnerTeam !== null && me?.team === r.winnerTeam;
    const outcome = r.winnerTeam === null ? 'Draw' : won ? 'Victory' : me ? 'Defeat' : `Team ${r.winnerTeam + 1} wins`;
    const cls = r.winnerTeam === null ? 'draw' : won ? 'win' : 'loss';
    const mine = r.stats.find((s) => s.player === r.localPlayer);

    const rows = [...r.setup.players]
      .sort((a, b) => a.team - b.team || a.id - b.id)
      .map((p) => {
        const s = r.stats.find((x) => x.player === p.id);
        const winner = r.winnerTeam === p.team;
        return h(
          'tr',
          { class: `${p.id === r.localPlayer ? 'me' : ''}${winner ? ' winner' : ''}` },
          h('td', null, h('span', { class: 'player-cell' }, h('span', { class: 'swatch', style: { background: p.color } }), h('span', null, p.name), p.kind === 'ai' ? h('span', { class: 'tag' }, 'AI') : null, winner ? h('span', { class: 'win-mark', html: icon('trophy', 'ic-sm') }) : null)),
          h('td', { class: 'mono' }, `T${p.team + 1}`),
          ...[s?.kills, s?.unitsLost, s?.unitsProduced, s?.structuresBuilt, s?.pointsCaptured, s?.damageDealt].map((v) => h('td', { class: 'num' }, fmtInt(v ?? 0))),
        );
      });

    const highlights: [string, string][] = [
      ['Duration', fmtClock(r.durationSec)],
      ['Kills', fmtInt(mine?.kills ?? 0)],
      ['Units lost', fmtInt(mine?.unitsLost ?? 0)],
      ['Points taken', fmtInt(mine?.pointsCaptured ?? 0)],
    ];

    this.chart = h('div', { class: 'chart-wrap' });
    const medals = extras.newMedals ?? [];

    this.el = h(
      'div',
      { class: 'screen results-screen' },
      h(
        'div',
        { class: `results-card ${cls}` },
        h(
          'header',
          { class: 'results-head' },
          h('div', { class: 'eyebrow' }, `After-action report · ${r.mapName ?? r.setup.mapId}`),
          h('h1', { class: 'outcome' }, outcome),
          h('div', { class: 'results-reason' }, r.reason ?? ''),
        ),
        h('div', { class: 'highlights' }, highlights.map(([k, v]) => h('div', { class: 'hl' }, h('span', { class: 'hl-v' }, v), h('span', { class: 'hl-k' }, k)))),
        medals.length
          ? h(
              'section',
              { class: 'new-medals' },
              h('div', { class: 'label' }, medals.length > 1 ? 'Medals earned' : 'Medal earned'),
              h('div', { class: 'medal-row' }, medals.map((m) => h('div', { class: 'medal-chip' }, h('span', { class: 'medal-ic', html: icon(m.icon, 'ic-md') }), h('div', null, h('b', null, m.name), h('span', null, m.desc))))),
            )
          : null,
        r.timeline && r.timeline.length > 1
          ? h(
              'section',
              { class: 'panel results-chart' },
              h('div', { class: 'panel-title' }, h('span', null, 'The match'), h('div', { class: 'segmented' }, METRICS.map((m) => h('button', { class: m.id === this.metric ? 'on' : '', type: 'button', dataset: { m: m.id }, onclick: () => this.setMetric(m.id) }, m.label)))),
              this.chart,
            )
          : null,
        h(
          'table',
          { class: 'stats-table panel' },
          h('thead', null, h('tr', null, ['Player', 'Team', 'Kills', 'Lost', 'Trained', 'Built', 'Captures', 'Damage'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
          h('tbody', null, rows),
        ),
        h(
          'div',
          { class: 'results-foot' },
          extras.saveReplay ? button([h('span', { html: icon('download') }), 'Save replay'], () => extras.saveReplay?.(), 'btn-ghost') : null,
          extras.watchReplay ? button([h('span', { html: icon('replay') }), 'Watch replay'], () => extras.watchReplay?.(), 'btn-ghost') : null,
          h('span', { class: 'grow' }),
          button('Return to menu', onContinue, 'btn-accent btn-lg'),
        ),
      ),
    );
    this.renderChart();
  }

  private setMetric(m: Metric): void {
    this.metric = m;
    this.el.querySelectorAll<HTMLElement>('.results-chart .segmented button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    this.renderChart();
  }

  private renderChart(): void {
    const tl = this.r.timeline;
    if (!tl || tl.length < 2) return;
    const m = this.metric;
    const players = this.r.setup.players;
    const series: { name: string; color: string; values: number[]; me: boolean }[] = [];
    if (m === 'morale') {
      const teams = [...new Set(players.map((p) => p.team))].sort((a, b) => a - b);
      const myTeam = players.find((p) => p.id === this.r.localPlayer)?.team;
      for (const t of teams) {
        const ps = players.filter((p) => p.team === t);
        series.push({ name: t === myTeam ? 'Our team' : ps.map((p) => p.name).join(' + '), color: ps[0].color, values: tl.map((s) => s.morale[t] ?? 0), me: t === myTeam });
      }
    } else {
      for (const p of players) series.push({ name: p.name, color: p.color, values: tl.map((s) => s[m][p.id] ?? 0), me: p.id === this.r.localPlayer });
    }
    setChildren(this.chart, lineChart(tl.map((s) => s.t), series, METRICS.find((x) => x.id === m)!.detail));
  }
}

/**
 * Small SVG line chart: one y axis, recessive grid, 2 px lines in the series' (player) color, a
 * legend with direct end labels, and a crosshair tooltip on hover.
 */
export function lineChart(xs: number[], series: { name: string; color: string; values: number[]; me: boolean }[], caption: string): HTMLElement {
  const W = 860;
  const H = 230;
  const pad = { l: 46, r: 18, t: 14, b: 26 };
  const maxX = Math.max(1, xs[xs.length - 1]);
  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  const step = niceStep(rawMax / 4);
  const maxY = Math.ceil(rawMax / step) * step;
  const X = (t: number) => pad.l + (t / maxX) * (W - pad.l - pad.r);
  const Y = (v: number) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);
  let grid = '';
  for (let v = 0; v <= maxY + 1e-9; v += step) {
    grid += `<line class="gl" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="gt" x="${pad.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtInt(v)}</text>`;
  }
  const xStep = niceStep(maxX / 6 / 60) * 60;
  for (let t = 0; t <= maxX; t += xStep) grid += `<text class="gt" x="${X(t)}" y="${H - 6}" text-anchor="middle">${fmtClock(t)}</text>`;
  const lines = series
    .map((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
      return `<path class="ln${s.me ? ' me' : ''}" d="${d}" stroke="${s.color}"/>`;
    })
    .join('');
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${caption}">${grid}${lines}<line class="xh" y1="${pad.t}" y2="${H - pad.b}" x1="-10" x2="-10"/><g class="dots"></g></svg>`;
  const tip = h('div', { class: 'chart-tip hidden' });
  const box = h('div', { class: 'chart-box', html: svg }, tip);
  const svgEl = box.querySelector('svg')!;
  const xh = svgEl.querySelector<SVGLineElement>('.xh')!;
  const dots = svgEl.querySelector('.dots')!;
  box.addEventListener('pointermove', (e) => {
    const r = svgEl.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = ((px - pad.l) / (W - pad.l - pad.r)) * maxX;
    let i = 0;
    for (let k = 0; k < xs.length; k++) if (Math.abs(xs[k] - t) < Math.abs(xs[i] - t)) i = k;
    xh.setAttribute('x1', String(X(xs[i])));
    xh.setAttribute('x2', String(X(xs[i])));
    dots.innerHTML = series.map((s) => `<circle cx="${X(xs[i])}" cy="${Y(s.values[i])}" r="4" fill="${s.color}"/>`).join('');
    setChildren(
      tip,
      h('div', { class: 'ct-t' }, fmtClock(xs[i])),
      [...series]
        .sort((a, b) => b.values[i] - a.values[i])
        .map((s) => h('div', { class: 'ct-row' }, h('span', { class: 'swatch', style: { background: s.color } }), h('span', null, s.name), h('b', null, fmtInt(s.values[i])))),
    );
    tip.classList.remove('hidden');
    const left = ((X(xs[i]) / W) * r.width);
    tip.style.left = `${Math.min(r.width - 180, left + 14)}px`;
  });
  box.addEventListener('pointerleave', () => {
    tip.classList.add('hidden');
    xh.setAttribute('x1', '-10');
    xh.setAttribute('x2', '-10');
    dots.innerHTML = '';
  });
  return h(
    'div',
    { class: 'chart-outer' },
    h('div', { class: 'chart-legend' }, series.map((s) => h('span', { class: `lg${s.me ? ' me' : ''}` }, h('span', { class: 'lg-line', style: { background: s.color } }), s.name)), h('span', { class: 'chart-cap' }, caption)),
    box,
  );
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
