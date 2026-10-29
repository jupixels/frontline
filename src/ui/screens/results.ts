import type { MatchSetup, PlayerId, TeamId } from '../../shared/types';
import { button, fmtClock, fmtInt, h } from '../dom';
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
  /** Short line, e.g. "Enemy HQ destroyed", "Tickets depleted", "Surrendered". */
  reason?: string;
}

/** Post-match debrief: outcome banner and a per-player stat table. */
export class ResultsScreen implements Screen {
  readonly el: HTMLElement;

  constructor(r: MatchResult, onContinue: () => void) {
    const me = r.setup.players.find((p) => p.id === r.localPlayer);
    const won = r.winnerTeam !== null && me?.team === r.winnerTeam;
    const outcome = r.winnerTeam === null ? 'DRAW' : won ? 'VICTORY' : me ? 'DEFEAT' : `TEAM ${r.winnerTeam + 1} WINS`;
    const cls = r.winnerTeam === null ? 'draw' : won ? 'win' : 'loss';

    const rows = [...r.setup.players]
      .sort((a, b) => a.team - b.team || a.id - b.id)
      .map((p) => {
        const s = r.stats.find((x) => x.player === p.id);
        const winner = r.winnerTeam === p.team;
        return h(
          'tr',
          { class: `${p.id === r.localPlayer ? 'me' : ''}${winner ? ' winner' : ''}` },
          h('td', null, h('span', { class: 'player-cell' }, h('span', { class: 'swatch', style: { background: p.color } }), h('span', null, p.name), p.kind === 'ai' ? h('span', { class: 'tag' }, 'AI') : null)),
          h('td', { class: 'mono' }, `T${p.team + 1}`),
          h('td', { class: 'mono num' }, fmtInt(s?.kills ?? 0)),
          h('td', { class: 'mono num' }, fmtInt(s?.unitsLost ?? 0)),
          h('td', { class: 'mono num' }, fmtInt(s?.unitsProduced ?? 0)),
          h('td', { class: 'mono num' }, fmtInt(s?.structuresBuilt ?? 0)),
          h('td', { class: 'mono num' }, fmtInt(s?.pointsCaptured ?? 0)),
          h('td', { class: 'mono num' }, fmtInt(s?.damageDealt ?? 0)),
        );
      });

    this.el = h(
      'div',
      { class: 'screen results-screen' },
      h(
        'div',
        { class: `results-card ${cls}` },
        h('div', { class: 'eyebrow mono' }, 'AFTER-ACTION REPORT'),
        h('h1', { class: 'outcome' }, outcome),
        h('div', { class: 'results-meta mono' }, h('span', null, `Duration ${fmtClock(r.durationSec)}`), r.reason ? h('span', null, r.reason) : null),
        h(
          'table',
          { class: 'stats-table' },
          h(
            'thead',
            null,
            h('tr', null, ['Player', 'Team', 'Kills', 'Lost', 'Trained', 'Built', 'Captures', 'Damage'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t))),
          ),
          h('tbody', null, rows),
        ),
        h('div', { class: 'results-foot' }, button('Return to menu', onContinue, 'btn-accent btn-lg')),
      ),
    );
  }
}
