import { SIM_HZ, type PlayerId, type Tick } from '../../shared/types';
import { fmtClock, fmtInt, h, setChildren } from '../dom';
import { ICONS } from '../glyphs';
import type { SimAdapter } from '../simAdapter';

/** Resource readouts (left), morale per team + clock (center), net/fps + menu (right). */
export class TopBar {
  readonly el: HTMLElement;
  private readonly supply: HTMLElement;
  private readonly supplyRate: HTMLElement;
  private readonly power: HTMLElement;
  private readonly cp: HTMLElement;
  private readonly morale: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly net: HTMLElement;
  private readonly powerRes: HTMLElement;
  private readonly cpRes: HTMLElement;
  private moraleKey = '';
  private samples: { t: number; v: number }[] = [];
  private fps = 60;

  constructor(
    private readonly adapter: SimAdapter,
    private readonly local: PlayerId,
    onMenu: () => void,
  ) {
    const res = (icon: string, label: string, value: HTMLElement, extra?: HTMLElement, cls = '') =>
      h('div', { class: `res ${cls}`, title: label }, h('span', { class: 'res-icon', html: icon }), h('span', { class: 'res-body' }, h('span', { class: 'res-label' }, label), h('span', { class: 'res-value mono' }, value, extra)));
    this.supply = h('span', null, '0');
    this.supplyRate = h('span', { class: 'res-rate' }, '');
    this.power = h('span', null, '0');
    this.cp = h('span', null, '0');
    this.morale = h('div', { class: 'morale' });
    this.clock = h('span', { class: 'mono clock-value' }, '00:00');
    this.net = h('span', { class: 'mono dim net' });
    this.powerRes = res(ICONS.power, 'Power', this.power, undefined, 'power');
    this.cpRes = res(ICONS.cp, 'Command', this.cp, undefined, 'cp');

    this.el = h(
      'div',
      { class: 'hud-topbar' },
      h('div', { class: 'hud-panel res-panel' }, res(ICONS.supply, 'Supply', this.supply, this.supplyRate, 'supply'), this.powerRes, this.cpRes),
      h('div', { class: 'hud-panel center-panel' }, this.morale, h('div', { class: 'clock' }, h('span', { class: 'clock-icon', html: ICONS.clock }), this.clock)),
      h('div', { class: 'hud-panel right-panel' }, this.net, h('button', { class: 'icon-btn', type: 'button', title: 'Game menu (F10)', html: ICONS.menu, onclick: onMenu })),
    );
  }

  update(tick: Tick, dt: number, opts: { showFps: boolean; pingMs?: number }): void {
    const eco = this.adapter.economy(this.local);
    this.supply.textContent = fmtInt(eco.supply);

    // Income per minute from a 10 s window of samples (spending shows as zero, not negative).
    const t = tick / SIM_HZ;
    const last = this.samples[this.samples.length - 1];
    if (!last || t - last.t >= 0.5) {
      this.samples.push({ t, v: eco.supply });
      while (this.samples.length > 2 && t - this.samples[0].t > 10) this.samples.shift();
    }
    let gained = 0;
    for (let i = 1; i < this.samples.length; i++) gained += Math.max(0, this.samples[i].v - this.samples[i - 1].v);
    const span = this.samples.length > 1 ? t - this.samples[0].t : 0;
    const rate = span > 2 ? (gained / span) * 60 : 0;
    this.supplyRate.textContent = rate >= 1 ? ` +${fmtInt(rate)}/m` : '';

    if (eco.power) {
      const net = eco.power.produced - eco.power.used;
      this.power.textContent = `${fmtInt(eco.power.used)}/${fmtInt(eco.power.produced)}`;
      this.powerRes.classList.toggle('warn', net < 0);
    } else {
      this.power.textContent = `${eco.netPower >= 0 ? '' : '−'}${fmtInt(Math.abs(eco.netPower))}`;
      this.powerRes.classList.toggle('warn', eco.netPower < 0);
    }
    this.cp.textContent = `${fmtInt(eco.commandPoints.used)}/${fmtInt(eco.commandPoints.cap)}`;
    this.cpRes.classList.toggle('warn', eco.commandPoints.used >= eco.commandPoints.cap);

    const teams = this.adapter.teamMorale();
    const myTeam = this.adapter.teamOf(this.local);
    const key = JSON.stringify(teams.map((x) => [x.team, Math.round(x.morale), x.defeated]));
    if (key !== this.moraleKey) {
      this.moraleKey = key;
      setChildren(
        this.morale,
        teams.map((tm) => {
          const frac = tm.max > 0 ? Math.max(0, Math.min(1, tm.morale / tm.max)) : 0;
          const chip = h(
            'div',
            {
              class: `morale${tm.team === myTeam ? ' mine' : ''}${tm.defeated ? ' defeated' : ''}${frac < 0.2 ? ' low' : ''}`,
              title: `Team ${tm.team + 1} Morale (${tm.players.map((p) => p.name).join(', ')}). At zero the side breaks.`,
              style: { '--team-color': tm.color },
            },
            h('span', { class: 'morale-label mono' }, `T${tm.team + 1} MORALE`),
            h('span', { class: 'morale-value mono' }, fmtInt(tm.morale)),
            h('span', { class: 'morale-bar' }, h('span', { class: 'morale-fill', style: { width: `${frac * 100}%` } })),
          );
          return chip;
        }),
      );
    }

    this.clock.textContent = fmtClock(t);
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    const parts: string[] = [];
    if (opts.pingMs !== undefined) parts.push(`${Math.round(opts.pingMs)} ms`);
    if (opts.showFps) parts.push(`${this.fps.toFixed(0)} fps`, `T${tick}`);
    this.net.textContent = parts.join(' · ');
  }
}
