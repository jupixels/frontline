import readme from '../../../README.md?raw';
import { assetUrl } from '../../shared/view';
import { button, escapeHtml, h, setChildren } from '../dom';
import type { Screen } from './screen';

/** Bullet lines of the README "## Credits" section, so the credits never drift from it. */
export function parseCredits(md: string): string[] {
  const start = md.search(/^## Credits\s*$/m);
  if (start < 0) return [];
  const rest = md.slice(start).split('\n').slice(1);
  const out: string[] = [];
  for (const line of rest) {
    if (/^#{1,2} /.test(line)) break;
    const m = /^\s*[-*] (.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Minimal inline markdown: **bold**, *em*, [text](url). Input is escaped first. */
function inline(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

interface CatalogModel {
  id: string;
  license?: string;
  credits?: string[];
}

/** Model credits grouped by author line: licenses and how many shipped models use each. */
export function modelCredits(models: CatalogModel[]): { credit: string; licenses: string[]; count: number }[] {
  const by = new Map<string, { licenses: Set<string>; ids: Set<string> }>();
  for (const m of models) {
    for (const c of m.credits ?? []) {
      const g = by.get(c) ?? { licenses: new Set<string>(), ids: new Set<string>() };
      if (m.license) g.licenses.add(m.license);
      g.ids.add(m.id);
      by.set(c, g);
    }
  }
  // A combined license ("CC0 + CC-BY-4.0") belongs to a kitbash of several authors; when the author
  // also has models under a single license, that one is theirs.
  const own = (ls: Set<string>) => {
    const single = [...ls].filter((l) => !l.includes('+'));
    return single.length ? single : [...ls];
  };
  return [...by.entries()].map(([credit, g]) => ({ credit, licenses: own(g.licenses), count: g.ids.size })).sort((a, b) => b.count - a.count || a.credit.localeCompare(b.credit));
}

const LICENSE_RE = /(CC BY(?:-SA)? \d\.\d|CC0)/;

export class CreditsScreen implements Screen {
  readonly el: HTMLElement;

  /** Filled from the shipped models/catalog.json, so it always matches the models in the build. */
  private readonly models = h('ul', { class: 'credit-list' }, h('li', { class: 'dim' }, 'Loading…'));

  constructor(private readonly onBack: () => void) {
    fetch(assetUrl('models/catalog.json'))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((cat: { models?: CatalogModel[] }) => {
        const rows = modelCredits(cat.models ?? []);
        setChildren(
          this.models,
          rows.map((r) => h('li', null, h('span', null, h('b', null, r.credit), h('span', { class: 'dim' }, ` · ${r.count} model${r.count > 1 ? 's' : ''}`)), h('span', { class: 'license mono' }, r.licenses.join(' · ')))),
        );
      })
      .catch(() => setChildren(this.models, h('li', { class: 'dim' }, 'Model credits are listed in the README.')));
    const lines = parseCredits(readme);
    const items = lines.map((l) => {
      const lic = LICENSE_RE.exec(l)?.[1];
      return h('li', null, h('span', { html: inline(l.replace(/,\s*(CC BY(?:-SA)? \d\.\d|CC0)\s*$/, '')) }), lic ? h('span', { class: 'license mono' }, lic) : null);
    });
    this.el = h(
      'div',
      { class: 'screen modal-screen' },
      h(
        'div',
        { class: 'modal panel credits' },
        h('div', { class: 'panel-title' }, h('span', null, 'CREDITS'), button('Close', onBack, 'btn-ghost btn-sm')),
        h(
          'div',
          { class: 'modal-body' },
          h('h3', null, 'Frontline'),
          h('p', { class: 'dim' }, 'A browser RTS built with three.js, TypeScript and Vite. Peer-to-peer multiplayer over WebRTC.'),
          h('h3', null, '3D models'),
          this.models,
          h('h3', null, 'Assets & licenses'),
          h('ul', { class: 'credit-list' }, items),
          h('h3', null, 'Libraries'),
          h('ul', { class: 'credit-list' }, h('li', null, h('span', null, h('b', null, 'three.js'), ' by mrdoob and contributors'), h('span', { class: 'license mono' }, 'MIT'))),
          h('p', { class: 'dim small' }, 'CC BY works are used under their licenses; no changes imply endorsement by the authors. CC0 authors are credited as a courtesy.'),
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
