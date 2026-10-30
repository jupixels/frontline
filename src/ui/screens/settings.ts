import { button, h, setChildren } from '../dom';
import { icon, type IconId } from '../icons';
import { ACTIONS, conflicts, isBindable, keyLabel, type ActionId } from '../keybinds';
import { QUALITY_PRESETS, type Settings, type SettingsStore, type VolumeSettings } from '../settings';
import { PALETTE_INFO } from '../teamColors';
import type { Screen } from './screen';

type Tab = 'gameplay' | 'graphics' | 'audio' | 'controls' | 'access';
const TABS: { id: Tab; label: string; icon: IconId }[] = [
  { id: 'gameplay', label: 'Gameplay', icon: 'army' },
  { id: 'graphics', label: 'Graphics', icon: 'display' },
  { id: 'audio', label: 'Audio', icon: 'sound' },
  { id: 'controls', label: 'Controls', icon: 'keyboard' },
  { id: 'access', label: 'Accessibility', icon: 'access' },
];

/** Settings modal. Every change is applied and saved immediately. */
export class SettingsScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly nav: HTMLElement;
  private tab: Tab = 'gameplay';
  private capturing: ActionId | null = null;
  private filter = '';
  private readonly unsub: () => void;

  constructor(
    private readonly store: SettingsStore,
    private readonly onClose: () => void,
  ) {
    this.body = h('div', { class: 'modal-body settings-body' });
    this.nav = h('nav', { class: 'settings-nav' });
    this.el = h(
      'div',
      { class: 'screen modal-screen' },
      h(
        'div',
        { class: 'modal panel settings brackets' },
        h('div', { class: 'panel-title' }, h('span', null, 'Settings'), button('Done', onClose, 'btn-ghost btn-sm')),
        h('div', { class: 'settings-layout' }, this.nav, this.body),
      ),
    );
    this.unsub = store.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    setChildren(
      this.nav,
      TABS.map((t) => h('button', { class: t.id === this.tab ? 'active' : '', type: 'button', onclick: () => this.setTab(t.id) }, h('span', { html: icon(t.icon, 'ic-sm') }), t.label)),
    );
    const s = this.store.get();
    const scroll = this.body.scrollTop;
    const focused = (document.activeElement as HTMLInputElement | null)?.classList.contains('kb-filter');
    const page = { gameplay: () => this.gameplay(s), graphics: () => this.graphics(s), audio: () => this.audio(s), controls: () => this.controls(s), access: () => this.access(s) }[this.tab]();
    setChildren(this.body, page);
    this.body.scrollTop = scroll;
    if (focused) this.body.querySelector<HTMLInputElement>('.kb-filter')?.focus();
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.capturing = null;
    this.body.scrollTop = 0;
    this.render();
  }

  private gameplay(s: Settings): HTMLElement {
    const name = h('input', { class: 'input', maxlength: 20, value: s.playerName, onchange: () => this.store.update({ playerName: name.value }) });
    return h(
      'div',
      { class: 'form' },
      row('Callsign', 'Shown to other players in lobbies.', name),
      row(
        'Edge-pan speed',
        'Screen-edge and keyboard scrolling. 0 turns edge-pan off.',
        slider(s.edgePanSpeed, 0, 2.5, 0.05, (v) => this.store.update({ edgePanSpeed: v }), (v) => (v === 0 ? 'Off' : `${v.toFixed(2)}×`)),
      ),
      row('Tooltips', 'Costs, counters, cooldowns and hotkeys when hovering buttons.', toggle(s.tooltips, (v) => this.store.update({ tooltips: v }))),
      row('Path lines for all units', 'Show where every unit of yours is headed, not only the selected ones.', toggle(s.allPaths, (v) => this.store.update({ allPaths: v }))),
      row('Show FPS', 'Frame rate and sim tick in the top bar.', toggle(s.showFps, (v) => this.store.update({ showFps: v }))),
    );
  }

  private graphics(s: Settings): HTMLElement {
    return h(
      'div',
      { class: 'form' },
      h('div', { class: 'form-section' }, 'Quality preset'),
      h(
        'div',
        { class: 'preset-grid' },
        QUALITY_PRESETS.map((q) =>
          h(
            'button',
            { class: `preset${q.id === s.graphics ? ' active' : ''}`, type: 'button', onclick: () => this.store.update({ graphics: q.id }) },
            h('span', { class: 'preset-name' }, q.label),
            h('span', { class: 'preset-detail' }, q.detail),
          ),
        ),
      ),
      h('p', { class: 'dim small' }, 'Presets switch shadows, ambient occlusion, bloom and particle budgets.'),
    );
  }

  private audio(s: Settings): HTMLElement {
    const vol = (key: keyof VolumeSettings, label: string, detail: string) =>
      row(label, detail, slider(s.volume[key], 0, 1, 0.01, (v) => this.store.update({ volume: { [key]: v } }), (v) => `${Math.round(v * 100)}`));
    return h(
      'div',
      { class: 'form' },
      vol('master', 'Master', 'Everything.'),
      vol('music', 'Music', 'Menu and battle score.'),
      vol('sfx', 'Effects', 'Weapons, engines, explosions, interface.'),
      vol('voice', 'Voices', 'Unit responses and announcer.'),
    );
  }

  private access(s: Settings): HTMLElement {
    return h(
      'div',
      { class: 'form' },
      h('div', { class: 'form-section' }, 'Team colors'),
      h(
        'div',
        { class: 'palette-opts' },
        PALETTE_INFO.map((p) =>
          h(
            'button',
            { class: `palette-opt${s.teamPalette === p.id ? ' active' : ''}`, type: 'button', onclick: () => this.store.update({ teamPalette: p.id }) },
            h('span', { class: 'palette-sw' }, p.preview.map((c) => h('i', { style: { background: c } }))),
            h('b', null, p.label),
            h('span', null, p.detail),
          ),
        ),
      ),
      h('p', { class: 'dim small' }, 'Only changes what you see (map, minimap, HUD). Applies from the next match.'),
      h('div', { class: 'form-section' }, 'Interface'),
      row('Interface scale', 'Size of the HUD, menus and tooltips.', slider(s.uiScale, 0.75, 1.5, 0.05, (v) => this.store.update({ uiScale: v }), (v) => `${Math.round(v * 100)}%`)),
      row('Motion', 'Reduce animations, pulses and transitions.', segmented(s.motion, [['system', 'System'], ['full', 'Full'], ['reduced', 'Reduced']], (v) => this.store.update({ motion: v as Settings['motion'] }))),
      row('Touch controls', 'On-screen controls for tablets and phones.', segmented(s.touch, [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], (v) => this.store.update({ touch: v as Settings['touch'] }))),
      h('div', { class: 'form-section' }, 'Keys'),
      h('p', { class: 'dim small' }, 'Every keyboard action, control groups included, can be rebound under Controls.'),
    );
  }

  private controls(s: Settings): HTMLElement {
    const groups = new Map<string, (typeof ACTIONS)[number][]>();
    const q = this.filter.trim().toLowerCase();
    for (const a of ACTIONS) {
      if (q && !a.label.toLowerCase().includes(q) && !keyLabel(s.keybinds[a.id]).toLowerCase().includes(q)) continue;
      const g = groups.get(a.group) ?? [];
      g.push(a);
      groups.set(a.group, g);
    }
    const clash = (id: ActionId) => ACTIONS.some((o) => o.id !== id && s.keybinds[o.id] === s.keybinds[id] && conflicts(id, o.id));
    const search = h('input', {
      class: 'input kb-filter',
      placeholder: 'Search actions or keys…',
      value: this.filter,
      oninput: () => {
        this.filter = search.value;
        this.render();
      },
    });
    return h(
      'div',
      { class: 'form keybinds' },
      h('div', { class: 'kb-search' }, search, h('span', { class: 'dim small' }, 'Click a key, then press the new one. Esc cancels.')),
      [...groups.entries()].map(([g, actions]) =>
        h(
          'section',
          { class: 'kb-group' },
          h('h4', null, g),
          actions.map((a) =>
            h(
              'div',
              { class: `kb-row${clash(a.id) ? ' conflict' : ''}` },
              h('span', null, a.label),
              h(
                'button',
                {
                  class: `keycap${this.capturing === a.id ? ' capturing' : ''}`,
                  type: 'button',
                  onclick: () => {
                    this.capturing = this.capturing === a.id ? null : a.id;
                    this.render();
                  },
                },
                this.capturing === a.id ? 'Press a key…' : keyLabel(s.keybinds[a.id]),
              ),
            ),
          ),
        ),
      ),
      q
        ? null
        : h(
            'section',
            { class: 'kb-group' },
            h('h4', null, 'Mouse and modifiers'),
            fixed('Select / box select', 'Left mouse'),
            fixed('Move / attack / set rally', 'Right mouse'),
            fixed('Formation facing', 'Right drag'),
            fixed('Add to selection · queue orders', 'Shift'),
            fixed('Select all of type', 'Ctrl+click · double-click'),
            fixed('Save group (with a group key)', 'Ctrl'),
            fixed('Rotate camera', 'Middle drag · PgUp/PgDn'),
          ),
      h('div', { class: 'form-foot' }, button('Reset to defaults', () => this.store.resetKeys(), 'btn-ghost')),
    );
  }

  onKey(e: KeyboardEvent): boolean {
    if (this.capturing) {
      e.preventDefault();
      if (e.code === 'Escape') this.capturing = null;
      else if (isBindable(e.code)) {
        const a = this.capturing;
        this.capturing = null;
        this.store.setKey(a, e.code);
        return true;
      } else return true;
      this.render();
      return true;
    }
    if (e.key === 'Escape') {
      this.onClose();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.unsub();
  }
}

function row(label: string, detail: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'form-row' }, h('div', { class: 'form-label' }, h('span', null, label), h('span', { class: 'dim small' }, detail)), control);
}

function fixed(label: string, keys: string): HTMLElement {
  return h('div', { class: 'kb-row fixed' }, h('span', null, label), h('span', { class: 'keycap static' }, keys));
}

function segmented(value: string, opts: [string, string][], onChange: (v: string) => void): HTMLElement {
  return h('div', { class: 'segmented' }, opts.map(([v, label]) => h('button', { class: v === value ? 'on' : '', type: 'button', onclick: () => onChange(v) }, label)));
}

function slider(value: number, min: number, max: number, step: number, onChange: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const out = h('span', { class: 'mono slider-val' }, fmt(value));
  const input = h('input', {
    type: 'range',
    class: 'range',
    min,
    max,
    step,
    value,
    oninput: () => {
      out.textContent = fmt(Number(input.value));
      input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    },
    onchange: () => onChange(Number(input.value)),
  });
  input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
  return h('div', { class: 'slider' }, input, out);
}

function toggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h('button', { class: `toggle${value ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(value), onclick: () => onChange(!value) }, h('span', { class: 'knob' }));
}
