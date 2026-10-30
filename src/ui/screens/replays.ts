import { parseReplay, type ReplayFile } from '../../net/replay';
import { button, fmtClock, h, setChildren } from '../dom';
import { icon } from '../icons';
import { deleteReplay, listReplays } from '../replayStore';
import type { Screen } from './screen';

/** Replay browser: recent matches kept in this browser, or open / drop a .replay.json file. */
export class ReplaysScreen implements Screen {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly error: HTMLElement;
  private readonly fileInput: HTMLInputElement;

  constructor(
    private readonly onWatch: (r: ReplayFile, name: string) => void,
    private readonly onDownload: (r: ReplayFile) => void,
    private readonly onBack: () => void,
  ) {
    this.list = h('div', { class: 'replay-list' });
    this.error = h('div', { class: 'field-error' });
    this.fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: () => this.fileInput.files?.[0] && this.openFile(this.fileInput.files[0]) });
    const drop = h(
      'div',
      { class: 'dropzone' },
      h('span', { html: icon('upload', 'ic-md') }),
      h('div', null, h('b', null, 'Open a replay file'), h('span', { class: 'dim small' }, 'Drop a .replay.json here, or browse')),
      button('Browse…', () => this.fileInput.click(), 'btn-sm'),
      this.fileInput,
    );
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.openFile(f);
    });
    this.el = h(
      'div',
      { class: 'screen modal-screen' },
      h(
        'div',
        { class: 'modal panel replays brackets' },
        h('div', { class: 'panel-title' }, h('span', null, 'Replays'), button('Close', onBack, 'btn-ghost btn-sm')),
        h('div', { class: 'modal-body' }, drop, this.error, h('h3', null, 'Recent matches'), this.list, h('p', { class: 'faint small' }, 'The last six matches are kept in this browser. Save a file from the results screen to keep one for good or send it to someone.')),
      ),
    );
    this.render();
  }

  private render(): void {
    const items = listReplays();
    if (!items.length) {
      setChildren(this.list, h('p', { class: 'dim' }, 'No recent matches yet. Play one, and it appears here.'));
      return;
    }
    setChildren(
      this.list,
      items.map((r) =>
        h(
          'div',
          { class: 'replay-row' },
          h('span', { class: `res-pill ${r.won === true ? 'win' : r.won === false ? 'loss' : 'draw'}` }, r.won === true ? 'Won' : r.won === false ? 'Lost' : '—'),
          h('div', { class: 'replay-main' }, h('b', null, r.mapName), h('span', { class: 'replay-players' }, r.players.map((p) => h('span', { class: 'rp' }, h('span', { class: 'swatch', style: { background: p.color } }), p.name)))),
          h('span', { class: 'mono dim' }, fmtClock(r.durationSec)),
          h('span', { class: 'dim small' }, new Date(r.savedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
          button([h('span', { html: icon('play', 'ic-sm') }), 'Watch'], () => this.onWatch(r.replay, r.mapName), 'btn-accent btn-sm'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Save file', html: icon('download', 'ic-sm'), onclick: () => this.onDownload(r.replay) }),
          h('button', { class: 'icon-btn', type: 'button', title: 'Delete', html: icon('cancel', 'ic-sm'), onclick: () => (deleteReplay(r.id), this.render()) }),
        ),
      ),
    );
  }

  private openFile(f: File): void {
    this.error.textContent = '';
    f.text().then(
      (text) => {
        try {
          const r = parseReplay(text);
          this.onWatch(r, f.name);
        } catch (err) {
          this.error.textContent = (err as Error).message;
        }
      },
      () => (this.error.textContent = "Couldn't read that file."),
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
