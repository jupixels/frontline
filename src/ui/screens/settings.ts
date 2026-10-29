import { button, h, setChildren } from '../dom';
import { ACTIONS, isBindable, keyLabel, type ActionId } from '../keybinds';
import { QUALITY_PRESETS, type Settings, type SettingsStore, type VolumeSettings } from '../settings';
import type { Screen } from './screen';

type Tab = 'gameplay' | 'graphics' | 'audio' | 'controls';
const TABS: { id: Tab; label: string }[] = [
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'audio', label: 'Audio' },
  { id: 'controls', label: 'Controls' },
];

/** Settings modal. Every change is applied and saved immediately. */
export class SettingsScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private tab: Tab = 'gameplay';
  private capturing: ActionId | null = null;
  private readonly unsub: () => void;

  constructor(
    private readonly store: SettingsStore,
    private readonly onClose: () => void,
  ) {
    this.body = h('div', { class: 'modal-body settings-body' });
    this.tabsEl = h('div', { class: 'tabs' });
    this.el = h(
      'div',
      { class: 'screen modal-screen' },
      h(
        'div',
        { class: 'modal panel settings' },
        h('div', { class: 'panel-title' }, h('span', null, 'SETTINGS'), button('Done', onClose, 'btn-ghost btn-sm')),
        this.tabsEl,
        this.body,
      ),
    );
    this.unsub = store.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    setChildren(
      this.tabsEl,
      TABS.map((t) =>
        h('button', { class: `tab${t.id === this.tab ? ' active' : ''}`, type: 'button', onclick: () => this.setTab(t.id) }, t.label),
      ),
    );
    const s = this.store.get();
    const scroll = this.body.scrollTop;
    setChildren(this.body, this.tab === 'gameplay' ? this.gameplay(s) : this.tab === 'graphics' ? this.graphics(s) : this.tab === 'audio' ? this.audio(s) : this.controls(s));
    this.body.scrollTop = scroll;
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.capturing = null;
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
        'Screen-edge and arrow-key scrolling. 0 turns edge-pan off.',
        slider(s.edgePanSpeed, 0, 2.5, 0.05, (v) => this.store.update({ edgePanSpeed: v }), (v) => (v === 0 ? 'Off' : `${v.toFixed(2)}×`)),
      ),
      row('Interface scale', 'Size of the in-game HUD.', slider(s.uiScale, 0.85, 1.25, 0.05, (v) => this.store.update({ uiScale: v }), (v) => `${Math.round(v * 100)}%`)),
      row('Show FPS', 'Frame rate and sim tick in the top bar.', toggle(s.showFps, (v) => this.store.update({ showFps: v }))),
    );
  }

  private graphics(s: Settings): HTMLElement {
    return h(
      'div',
      { class: 'form' },
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
      h('p', { class: 'dim small' }, 'Presets switch shadows, ambient occlusion, bloom and particle budgets. Changes apply on the next match if the renderer cannot switch live.'),
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

  private controls(s: Settings): HTMLElement {
    const groups = new Map<string, typeof ACTIONS[number][]>();
    for (const a of ACTIONS) {
      const g = groups.get(a.group) ?? [];
      g.push(a);
      groups.set(a.group, g);
    }
    return h(
      'div',
      { class: 'form keybinds' },
      [...groups.entries()].map(([g, actions]) =>
        h(
          'section',
          { class: 'kb-group' },
          h('h4', null, g),
          actions.map((a) =>
            h(
              'div',
              { class: 'kb-row' },
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
      h(
        'section',
        { class: 'kb-group' },
        h('h4', null, 'Fixed'),
        fixed('Select / box select', 'Left mouse'),
        fixed('Move / attack / set rally', 'Right mouse'),
        fixed('Formation facing', 'Right drag'),
        fixed('Add to selection · queue orders', 'Shift'),
        fixed('Select all of type', 'Ctrl+click · double-click'),
        fixed('Set / recall control group', 'Ctrl+1–9 · 1–9'),
        fixed('Pan camera', 'Arrows · screen edge'),
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
