import { COMMAND_ROLES, type CommandRole, type VictoryMode } from '../../shared/types';
import { button, h, setChildren } from '../dom';
import { icon } from '../icons';
import {
  TEAM_COLORS,
  isHost,
  selfSlot,
  shareLink,
  startBlocker,
  takenSlots,
  type ChatMessage,
  type LobbyApi,
  type LobbySlot,
  type LobbyState,
  type MapInfo,
  type MatchMode,
  type SlotOccupancy,
} from '../lobbyApi';
import type { Screen } from './screen';

export const VICTORY_INFO: Record<VictoryMode, { label: string; detail: string }> = {
  frontline: {
    label: 'Frontline',
    detail: 'Each side starts with 1000 Morale. Holding more strategic points than the enemy drains theirs, and every loss costs a little. A side whose Morale breaks loses. Destroying the enemy HQ also wins.',
  },
  annihilation: { label: 'Annihilation', detail: 'Destroy every enemy production building. No Morale race, no timer.' },
};

const ROLE_LABEL: Record<CommandRole, string> = { ground: 'Ground', air: 'Air', navy: 'Navy', logistics: 'Logistics' };

const OCCUPANCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'ai:easy', label: 'AI · Easy' },
  { value: 'ai:normal', label: 'AI · Normal' },
  { value: 'ai:hard', label: 'AI · Hard' },
];

function occupancyValue(s: LobbySlot): string {
  if (s.occupant?.kind === 'ai') return `ai:${s.occupant.difficulty}`;
  return s.state === 'closed' ? 'closed' : 'open';
}

function parseOccupancy(v: string): SlotOccupancy {
  if (v.startsWith('ai:')) return { ai: v.slice(3) as 'easy' | 'normal' | 'hard' };
  return v === 'closed' ? 'closed' : 'open';
}

export interface LobbyScreenOptions {
  lobby: LobbyApi;
  maps: MapInfo[];
  mode: MatchMode;
  onLeave(): void;
  toast(msg: string): void;
}

/** Room lobby: slots (team/color/ready), host map + victory pickers, chat, invite link. */
export class LobbyScreen implements Screen {
  readonly el: HTMLElement;
  private readonly slotsEl: HTMLElement;
  private readonly mapPanel: HTMLElement;
  private readonly chatLog: HTMLElement;
  private readonly chatInput: HTMLInputElement;
  private readonly footer: HTMLElement;
  private readonly header: HTMLElement;
  private readonly rowCache = new Map<number, { key: string; el: HTMLElement }>();
  private mapKey = '';
  private readonly unsubs: (() => void)[] = [];
  private popover: HTMLElement | null = null;

  constructor(private readonly opts: LobbyScreenOptions) {
    const { lobby, mode } = opts;
    this.header = h('header', { class: 'lobby-head' });
    this.slotsEl = h('div', { class: 'slot-list' });
    this.mapPanel = h('div', { class: 'panel map-panel' });
    this.chatLog = h('div', { class: 'chat-log' });
    this.chatInput = h('input', {
      class: 'input chat-input',
      placeholder: 'Message the room…',
      maxlength: 240,
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && this.chatInput.value.trim()) {
          lobby.sendChat(this.chatInput.value);
          this.chatInput.value = '';
        }
      },
    });
    this.footer = h('footer', { class: 'lobby-foot' });

    const chatPanel =
      mode === 'online'
        ? h('section', { class: 'panel chat-panel' }, h('div', { class: 'panel-title' }, h('span', null, 'COMMS'), h('span', { class: 'dim mono' }, 'room chat')), this.chatLog, this.chatInput)
        : h(
            'section',
            { class: 'panel chat-panel briefing' },
            h('div', { class: 'panel-title' }, h('span', null, 'BRIEFING')),
            h(
              'div',
              { class: 'briefing-body' },
              h('p', null, 'Set open slots to AI to add opponents or allies. Put players on the same team to fight together; give everyone a different team for free-for-all.'),
              h('p', { class: 'dim' }, 'Easy AI expands slowly and rarely attacks. Hard AI micro-manages and raids your power.'),
            ),
          );

    this.el = h(
      'div',
      { class: 'screen lobby-screen' },
      this.header,
      h(
        'div',
        { class: 'lobby-body' },
        h(
          'section',
          { class: 'panel slots-panel' },
          h(
            'div',
            { class: 'panel-title' },
            h('span', null, mode === 'online' ? 'PLAYERS' : 'FORCES'),
            h('span', { class: 'team-presets' }),
          ),
          h('div', { class: 'slot-head mono' }, h('span', null, '#'), h('span', null, 'Player'), h('span', null, 'Team'), h('span', null, 'Status'), h('span', null, '')),
          this.slotsEl,
        ),
        h('div', { class: 'lobby-side' }, this.mapPanel, chatPanel),
      ),
      this.footer,
    );

    this.unsubs.push(lobby.subscribe((s) => this.render(s)));
    this.unsubs.push(lobby.onChat((m) => this.addChat(m)));
    this.el.addEventListener('pointerdown', (e) => {
      if (this.popover && !this.popover.contains(e.target as Node)) this.closePopover();
    });
    this.render(lobby.getState());
  }

  private get state(): LobbyState {
    return this.opts.lobby.getState();
  }

  private render(s: LobbyState): void {
    if (s.status === 'closed') return;
    this.renderHeader(s);
    this.renderSlots(s);
    this.renderMap(s);
    this.renderFooter(s);
    this.renderPresets(s);
  }

  private renderHeader(s: LobbyState): void {
    const online = this.opts.mode === 'online';
    const status = s.status === 'starting' ? 'LAUNCHING' : s.status === 'connecting' ? 'CONNECTING' : 'STAGING';
    const players = takenSlots(s).length;
    setChildren(
      this.header,
      h(
        'div',
        { class: 'lobby-title' },
        h('div', { class: 'eyebrow mono' }, online ? (isHost(s) ? 'HOSTING · PEER-TO-PEER' : 'JOINED · PEER-TO-PEER') : 'OFFLINE · VS AI'),
        h('h2', null, online ? 'Online lobby' : 'Skirmish'),
      ),
      online && s.code
        ? h(
            'div',
            { class: 'room-code' },
            h('span', { class: 'label' }, 'Room code'),
            h('span', { class: 'code mono' }, s.code),
            h('button', { class: 'btn btn-ghost', type: 'button', title: 'Copy invite link', onclick: () => this.copyLink(s.code!), html: `${icon('copy', 'ic-sm')}<span>Copy link</span>` }),
          )
        : null,
      h('div', { class: 'lobby-status mono' }, h('span', { class: `dot ${s.status}` }), status, h('span', { class: 'dim' }, ` · ${players}/${s.slots.filter((x) => x.state !== 'closed').length}`)),
    );
  }

  private copyLink(code: string): void {
    const link = shareLink(code);
    const done = () => this.opts.toast('Invite link copied');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => this.opts.toast(link));
    else this.opts.toast(link);
  }

  private renderPresets(s: LobbyState): void {
    const el = this.el.querySelector<HTMLElement>('.team-presets')!;
    if (!isHost(s)) {
      el.replaceChildren();
      return;
    }
    const assign = (fn: (i: number) => number) => {
      takenSlots(this.state).forEach((slot, i) => this.opts.lobby.updateSlot(slot.index, { team: fn(i) }));
    };
    setChildren(
      el,
      h('span', { class: 'dim' }, 'Teams'),
      button('2 sides', () => assign((i) => i % 2), 'btn-chip'),
      button('FFA', () => assign((i) => i), 'btn-chip'),
    );
  }

  private renderSlots(s: LobbyState): void {
    const host = isHost(s);
    const me = selfSlot(s);
    const keep = new Set<number>();
    s.slots.forEach((slot) => {
      keep.add(slot.index);
      const key = JSON.stringify([slot, host, me?.index, s.hostId, s.status, s.coop, takenSlots(s).map((x) => [x.index, x.team, x.occupant?.kind])]);
      const cached = this.rowCache.get(slot.index);
      if (cached && cached.key === key) return;
      const row = this.slotRow(s, slot, host, me);
      if (cached) cached.el.replaceWith(row);
      else this.slotsEl.appendChild(row);
      this.rowCache.set(slot.index, { key, el: row });
    });
    for (const [i, c] of this.rowCache) {
      if (!keep.has(i)) {
        c.el.remove();
        this.rowCache.delete(i);
      }
    }
    // Keep DOM order equal to slot order.
    for (const slot of s.slots) {
      const el = this.rowCache.get(slot.index)?.el;
      if (el) this.slotsEl.appendChild(el);
    }
  }

  private slotRow(s: LobbyState, slot: LobbySlot, host: boolean, me: LobbySlot | undefined): HTMLElement {
    const { lobby, mode } = this.opts;
    const o = slot.occupant;
    const isMe = o?.kind === 'human' && o.peerId === s.selfId;
    const isHostSlot = o?.kind === 'human' && o.peerId === s.hostId;
    const editable = slot.state === 'taken' && (isMe || host) && s.status === 'open';
    const row = h('div', { class: `slot-row ${slot.state}${isMe ? ' me' : ''}` });
    row.style.setProperty('--slot-color', slot.state === 'taken' ? slot.color : 'transparent');

    const num = h('span', { class: 'slot-num mono' }, String(slot.index + 1).padStart(2, '0'));

    let who: HTMLElement;
    if (slot.state === 'taken' && o) {
      const swatch = h('button', {
        class: 'swatch',
        type: 'button',
        title: editable ? 'Change color' : '',
        disabled: !editable,
        style: { background: slot.color },
        onclick: (e: MouseEvent) => this.openColorPicker(e.currentTarget as HTMLElement, slot),
      });
      const name = o.kind === 'human' ? o.name : `AI · ${o.difficulty[0].toUpperCase()}${o.difficulty.slice(1)}`;
      who = h(
        'span',
        { class: 'slot-who' },
        swatch,
        h('span', { class: 'slot-name' }, name),
        isHostSlot && mode === 'online' ? h('span', { class: 'tag' }, 'HOST') : null,
        isMe ? h('span', { class: 'tag tag-accent' }, 'YOU') : null,
      );
    } else if (host && s.status === 'open') {
      const sel = h(
        'select',
        { class: 'select', onchange: () => lobby.setOccupancy(slot.index, parseOccupancy(sel.value)) },
        OCCUPANCY_OPTIONS.map((opt) => h('option', { value: opt.value }, opt.label)),
      );
      sel.value = occupancyValue(slot);
      who = h('span', { class: 'slot-who' }, h('span', { class: 'swatch empty' }), sel);
    } else {
      who = h(
        'span',
        { class: 'slot-who' },
        h('span', { class: 'swatch empty' }),
        slot.state === 'closed'
          ? h('span', { class: 'dim' }, 'Closed')
          : me && s.status === 'open'
            ? button('Move here', () => lobby.moveToSlot(slot.index), 'btn-chip')
            : h('span', { class: 'dim' }, 'Open'),
      );
    }

    let team: HTMLElement;
    if (slot.state === 'taken' && editable) {
      const sel = h(
        'select',
        { class: 'select team-select', onchange: () => lobby.updateSlot(slot.index, { team: Number(sel.value) }) },
        Array.from({ length: Math.max(2, s.slots.length) }, (_, i) => h('option', { value: String(i) }, `Team ${i + 1}`)),
      );
      sel.value = String(slot.team);
      team = sel;
    } else team = h('span', { class: 'mono' }, slot.state === 'taken' ? `Team ${slot.team + 1}` : '—');

    let status: HTMLElement;
    if (slot.state !== 'taken') status = h('span', { class: 'dim mono' }, '—');
    else if (o?.kind === 'ai') status = h('span', { class: 'status ready mono' }, 'AI');
    else if (mode === 'skirmish' || isHostSlot) status = h('span', { class: 'status ready mono' }, mode === 'skirmish' ? 'COMMAND' : 'HOST');
    else status = h('span', { class: `status mono ${slot.ready ? 'ready' : 'waiting'}` }, slot.ready ? 'READY' : 'NOT READY');

    const tail = h('span', { class: 'slot-tail' });
    if (s.coop && o?.kind === 'human') {
      const mates = takenSlots(s).filter((x) => x.occupant?.kind === 'human' && x.team === slot.team);
      const lead = mates[0]?.index === slot.index;
      if ((isMe || host) && s.status === 'open') {
        const sel = h(
          'select',
          { class: 'select select-sm role-select', title: 'Co-op role', onchange: () => lobby.updateSlot(slot.index, { role: sel.value as CommandRole | '' }) },
          h('option', { value: '' }, 'Any role'),
          COMMAND_ROLES.map((r) => h('option', { value: r }, ROLE_LABEL[r])),
        );
        sel.value = slot.role ?? '';
        tail.append(sel);
      } else if (slot.role) tail.append(h('span', { class: 'tag' }, ROLE_LABEL[slot.role]));
      if (mates.length > 1) tail.append(h('span', { class: `tag ${lead ? 'tag-accent' : 'tag-info'}`, title: lead ? 'Leads the shared army' : 'Shares the army' }, lead ? 'Lead' : 'Co-op'));
    }
    if (slot.pingMs !== undefined && o?.kind === 'human' && !isMe && mode === 'online') {
      const q = slot.pingMs < 80 ? 'good' : slot.pingMs < 160 ? 'ok' : 'bad';
      tail.append(h('span', { class: `ping mono ${q}` }, `${slot.pingMs} ms`));
    }
    if (host && o && !isMe && s.status === 'open') {
      if (o.kind === 'human') tail.append(button('Kick', () => lobby.kick(o.peerId), 'btn-chip btn-danger'));
      else {
        const sel = h(
          'select',
          { class: 'select select-sm', title: 'Slot', onchange: () => lobby.setOccupancy(slot.index, parseOccupancy(sel.value)) },
          OCCUPANCY_OPTIONS.map((opt) => h('option', { value: opt.value }, opt.label)),
        );
        sel.value = occupancyValue(slot);
        tail.append(sel);
      }
    }

    row.append(num, who, team, status, tail);
    return row;
  }

  private openColorPicker(anchor: HTMLElement, slot: LobbySlot): void {
    this.closePopover();
    const used = new Map(takenSlots(this.state).map((s) => [s.color, s.index]));
    const pop = h(
      'div',
      { class: 'popover color-pop' },
      TEAM_COLORS.map((c) =>
        h('button', {
          class: `swatch${c === slot.color ? ' current' : ''}${used.has(c) && used.get(c) !== slot.index ? ' taken' : ''}`,
          type: 'button',
          title: used.has(c) && used.get(c) !== slot.index ? 'Swap with that player' : '',
          style: { background: c },
          onclick: () => {
            this.opts.lobby.updateSlot(slot.index, { color: c });
            this.closePopover();
          },
        }),
      ),
    );
    const r = anchor.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    pop.style.left = `${r.left - host.left}px`;
    pop.style.top = `${r.bottom - host.top + 6}px`;
    this.el.appendChild(pop);
    this.popover = pop;
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  private renderMap(s: LobbyState): void {
    const host = isHost(s) && s.status === 'open';
    const players = takenSlots(s);
    const key = JSON.stringify([s.mapId, s.victory, s.coop, host, players.map((p) => [p.index, p.color])]);
    if (key === this.mapKey) return;
    this.mapKey = key;
    const map = this.opts.maps.find((m) => m.id === s.mapId) ?? this.opts.maps[0];

    const canvas = h('canvas', { class: 'map-preview', width: 440, height: 440 });
    drawMapPreview(canvas, map, players.map((p, i) => ({ spawn: i, color: p.color })));

    const mapSel = host
      ? (() => {
          const sel = h(
            'select',
            {
              class: 'select',
              onchange: () => {
                this.opts.lobby.setMap(sel.value);
                // A refused change (map too small for everyone seated) leaves the old map selected.
                sel.value = this.opts.lobby.getState().mapId;
              },
            },
            this.opts.maps.map((m) => h('option', { value: m.id }, `${m.name}  ·  ${m.modes?.map(modeLabel).join(' / ') ?? `${m.maxPlayers}P`}`)),
          );
          sel.value = map.id;
          return sel;
        })()
      : h('span', { class: 'value' }, map.name);

    const vicSel = host
      ? (() => {
          const sel = h(
            'select',
            { class: 'select', onchange: () => this.opts.lobby.setVictory(sel.value as VictoryMode) },
            (Object.keys(VICTORY_INFO) as VictoryMode[]).map((v) => h('option', { value: v }, VICTORY_INFO[v].label)),
          );
          sel.value = s.victory;
          return sel;
        })()
      : h('span', { class: 'value' }, VICTORY_INFO[s.victory].label);

    setChildren(
      this.mapPanel,
      h('div', { class: 'panel-title' }, h('span', null, 'OPERATION'), h('span', { class: 'dim mono' }, `${(map.size / 1000).toFixed(1)} km · ${map.modes?.map(modeLabel).join(' / ') ?? `${map.maxPlayers} spawns`}`)),
      h(
        'div',
        { class: 'map-body' },
        canvas,
        h(
          'div',
          { class: 'map-fields' },
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Map'), mapSel),
          map.description ? h('p', { class: 'dim small' }, map.description) : null,
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Victory'), vicSel),
          h('p', { class: 'dim small' }, VICTORY_INFO[s.victory].detail),
          this.opts.mode === 'online' ? this.coopField(s, host) : null,
        ),
      ),
    );
  }

  private coopField(s: LobbyState, host: boolean): HTMLElement {
    const on = !!s.coop;
    const control =
      host && this.opts.lobby.setCoop
        ? h('button', { class: `toggle${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on), onclick: () => this.opts.lobby.setCoop?.(!on) }, h('span', { class: 'knob' }))
        : h('span', { class: `tag ${on ? 'tag-accent' : ''}` }, on ? 'On' : 'Off');
    return h(
      'div',
      { class: 'coop-field' },
      h('div', null, h('span', { class: 'label' }, 'Shared command (co-op)'), h('span', { class: 'dim small' }, 'Players on the same team run one army: one base, one economy. Pick roles to split it up; a role nobody holds stays open to everyone.')),
      control,
    );
  }

  private renderFooter(s: LobbyState): void {
    const { lobby, mode } = this.opts;
    const host = isHost(s);
    const me = selfSlot(s);
    const blocker = startBlocker(s);
    const leave = button(mode === 'online' ? 'Leave room' : 'Back', () => this.opts.onLeave(), 'btn-ghost');
    let right: HTMLElement[];
    if (s.status === 'starting') right = [h('span', { class: 'mono accent blink' }, 'DEPLOYING…')];
    else if (host) {
      const effective = mode === 'skirmish' && blocker?.startsWith('Waiting') ? null : blocker;
      const start = button(mode === 'online' ? 'Start match' : 'Deploy', () => lobby.start(), 'btn-accent btn-lg');
      start.disabled = !!effective;
      right = [h('span', { class: 'dim blocker' }, effective ?? 'All set'), start];
    } else {
      const ready = me?.ready ?? false;
      const btn = button(ready ? 'Ready ✓' : 'Ready up', () => me && lobby.updateSlot(me.index, { ready: !ready }), `btn-lg ${ready ? 'btn-accent' : ''}`);
      right = [h('span', { class: 'dim blocker' }, ready ? 'Waiting for host to start' : 'Ready up when you are set'), btn];
    }
    setChildren(this.footer, leave, h('div', { class: 'foot-right' }, right));
  }

  private addChat(m: ChatMessage): void {
    const t = new Date(m.at);
    const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const color = takenSlots(this.state).find((s) => s.occupant?.kind === 'human' && s.occupant.peerId === m.from)?.color;
    const line = h(
      'div',
      { class: `chat-line${m.from === 'system' ? ' system' : ''}` },
      h('span', { class: 'chat-time mono' }, stamp),
      m.from === 'system' ? null : h('span', { class: 'chat-name', style: color ? { color } : undefined }, m.name),
      h('span', { class: 'chat-text' }, m.text),
    );
    const atBottom = this.chatLog.scrollTop + this.chatLog.clientHeight >= this.chatLog.scrollHeight - 8;
    this.chatLog.appendChild(line);
    while (this.chatLog.childElementCount > 200) this.chatLog.firstElementChild?.remove();
    if (atBottom) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.popover) {
      this.closePopover();
      return true;
    }
    if (e.key === 'Enter' && this.opts.mode === 'online' && document.activeElement !== this.chatInput) {
      this.chatInput.focus();
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }
}

/** Top-down map thumbnail: grid, spawns numbered in player order, colored by who spawns there. */
export function drawMapPreview(canvas: HTMLCanvasElement, map: MapInfo, players: { spawn: number; color: string }[]): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width;
  const H = canvas.height;
  const bg = g.createRadialGradient(W / 2, H / 2, W * 0.1, W / 2, H / 2, W * 0.75);
  bg.addColorStop(0, '#2a3324');
  bg.addColorStop(1, '#161c14');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(200, 220, 190, 0.08)';
  g.lineWidth = 1;
  const step = W / 8;
  g.beginPath();
  for (let i = 1; i < 8; i++) {
    g.moveTo(i * step + 0.5, 0);
    g.lineTo(i * step + 0.5, H);
    g.moveTo(0, i * step + 0.5);
    g.lineTo(W, i * step + 0.5);
  }
  g.stroke();
  g.strokeStyle = 'rgba(200, 220, 190, 0.25)';
  g.strokeRect(0.5, 0.5, W - 1, H - 1);
  const toPx = (x: number, z: number) => [((x / map.size) + 0.5) * W, ((z / map.size) + 0.5) * H] as const;
  // Center objective marker.
  g.strokeStyle = 'rgba(227, 178, 60, 0.55)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(W / 2, H / 2 - 12);
  g.lineTo(W / 2 + 12, H / 2);
  g.lineTo(W / 2, H / 2 + 12);
  g.lineTo(W / 2 - 12, H / 2);
  g.closePath();
  g.stroke();
  map.spawns.forEach((sp, i) => {
    const [px, py] = toPx(sp.x, sp.z);
    const p = players.find((pl) => pl.spawn === i);
    g.fillStyle = p ? p.color : 'rgba(200, 220, 190, 0.18)';
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(px, py, 18, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = p ? '#0b0e0c' : 'rgba(200, 220, 190, 0.6)';
    g.font = 'bold 20px Consolas, ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), px, py + 1);
  });
}

/** '1v1' → '1v1', 'ffa4' → '4-player FFA'. */
function modeLabel(m: string): string {
  const ffa = /^ffa(\d)$/.exec(m);
  return ffa ? `${ffa[1]}-player FFA` : m;
}
