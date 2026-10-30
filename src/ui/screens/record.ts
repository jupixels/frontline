import { button, fmtClock, fmtInt, h } from '../dom';
import { icon } from '../icons';
import { ACHIEVEMENTS, emptyRecord, loadRecord, saveRecord } from '../records';
import type { Screen } from './screen';

/** Career stats, medals and recent matches, all from this browser's local record. */
export class RecordScreen implements Screen {
  readonly el: HTMLElement;

  constructor(private readonly onBack: () => void) {
    const r = loadRecord();
    const tiles: [string, string, string?][] = [
      ['Matches', fmtInt(r.matches)],
      ['Win rate', r.matches ? `${Math.round((r.wins / r.matches) * 100)}%` : '—', `${r.wins} won · ${r.losses} lost`],
      ['Kills', fmtInt(r.kills), `best ${fmtInt(r.bestKills)} in a match`],
      ['Units trained', fmtInt(r.produced)],
      ['Points taken', fmtInt(r.captures)],
      ['Time at the front', fmtClock(r.playSeconds)],
      ['Fastest victory', r.fastestWinSec === null ? '—' : fmtClock(r.fastestWinSec)],
      ['Longest match', r.longestSec ? fmtClock(r.longestSec) : '—'],
    ];
    const got = ACHIEVEMENTS.filter((a) => r.achievements[a.id]).length;
    const reset = button('Reset record', () => {
      if (reset.dataset.armed) {
        saveRecord(emptyRecord());
        this.onBack();
      } else {
        reset.dataset.armed = '1';
        reset.textContent = 'Click again to erase';
      }
    }, 'btn-ghost btn-sm');

    this.el = h(
      'div',
      { class: 'screen modal-screen' },
      h(
        'div',
        { class: 'modal panel record brackets' },
        h('div', { class: 'panel-title' }, h('span', null, 'Service record'), button('Close', onBack, 'btn-ghost btn-sm')),
        h(
          'div',
          { class: 'modal-body' },
          h('div', { class: 'tiles' }, tiles.map(([k, v, sub]) => h('div', { class: 'tile' }, h('span', { class: 'tile-v' }, v), h('span', { class: 'tile-k' }, k), sub ? h('span', { class: 'tile-sub' }, sub) : null))),
          h('h3', null, `Medals · ${got} of ${ACHIEVEMENTS.length}`),
          h(
            'div',
            { class: 'medals' },
            ACHIEVEMENTS.map((a) => {
              const at = r.achievements[a.id];
              return h(
                'div',
                { class: `medal${at ? ' got' : ''}` },
                h('span', { class: 'medal-ic', html: icon(at ? a.icon : 'lock', 'ic-md') }),
                h('div', null, h('b', null, a.name), h('span', null, a.desc), at ? h('span', { class: 'medal-date' }, new Date(at).toLocaleDateString()) : null),
              );
            }),
          ),
          h('h3', null, 'Recent matches'),
          r.history.length
            ? h(
                'table',
                { class: 'history' },
                h('thead', null, h('tr', null, ['', 'Map', 'Mode', 'Length', 'Kills', 'Lost', 'Date'].map((t, i) => h('th', { class: i >= 3 && i <= 5 ? 'num' : '' }, t)))),
                h(
                  'tbody',
                  null,
                  r.history.map((m) =>
                    h(
                      'tr',
                      null,
                      h('td', null, h('span', { class: `res-pill ${m.won === true ? 'win' : m.won === false ? 'loss' : 'draw'}` }, m.won === true ? 'Won' : m.won === false ? 'Lost' : 'Draw')),
                      h('td', null, m.mapName, m.medals?.length ? h('span', { class: 'medal-mini', title: `${m.medals.length} medal(s)`, html: icon('medal', 'ic-sm') }) : null),
                      h('td', { class: 'dim' }, `${m.mode === 'online' ? 'Online' : 'Skirmish'}${m.vsAi ? ` · ${m.vsAi} AI` : ''}`),
                      h('td', { class: 'num' }, fmtClock(m.durationSec)),
                      h('td', { class: 'num' }, fmtInt(m.kills)),
                      h('td', { class: 'num' }, fmtInt(m.lost)),
                      h('td', { class: 'dim' }, new Date(m.at).toLocaleDateString()),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'dim' }, 'No matches yet. Finished matches show up here, with their medals.'),
          h('div', { class: 'modal-actions' }, h('span', { class: 'faint small grow' }, 'Stored in this browser only.'), reset),
        ),
      ),
    );
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.onBack();
      return true;
    }
    return false;
  }
}
