import { SIM_HZ, type PlayerId, type Tick, type Vec2 } from '../../shared/types';
import { fmtClock, fmtInt, h, setChildren } from '../dom';
import { icon } from '../icons';
import type { SimAdapter } from '../simAdapter';
import { bindTip, tipText } from '../tooltip';

const SLOW_MS = 250;
const TIER_NEXT: Record<number, string> = { 1: 'Build a Radar Station to reach Tier 2: tanks, IFVs, artillery, helicopters.', 2: 'Build Strategic Command to reach Tier 3: jets, bombers, capital ships and the cruise missile.', 3: 'All tiers unlocked.' };

/** Write text only when it changed (no layout work for unchanged readouts). */
function setText(el: HTMLElement, s: string): void {
  if (el.textContent !== s) el.textContent = s;
}

function setWidth(el: HTMLElement, frac: number): void {
  const w = `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`;
  if (el.style.width !== w) el.style.width = w;
}

/**
 * Top of the HUD. Left: supply (with income), power and command-point meters, tech tier. Center:
 * Morale per team with the strategic points race between them, and the clock. Right: network,
 * co-commanders, help and menu.
 */
export class TopBar {
  readonly el: HTMLElement;
  private readonly supply = h('span', { class: 'res-value' }, '0');
  private readonly supplyRate = h('span', { class: 'res-rate' });
  private readonly power = h('span', { class: 'res-value' }, '0');
  private readonly powerFill = h('span', { class: 'meter-fill' });
  private readonly cp = h('span', { class: 'res-value' }, '0');
  private readonly cpFill = h('span', { class: 'meter-fill' });
  private readonly tier = h('span', { class: 'tier-value' }, 'I');
  private readonly powerRes: HTMLElement;
  private readonly cpRes: HTMLElement;
  private readonly tierRes: HTMLElement;
  private readonly morale = h('div', { class: 'morale-row' });
  private readonly points = h('div', { class: 'points-strip' });
  private readonly clock = h('span', { class: 'clock-value' }, '00:00');
  private readonly net = h('span', { class: 'net mono' });
  private readonly partners = h('div', { class: 'partners' });
  private moraleKey = '';
  private pointsKey = '';
  private samples: { t: number; v: number }[] = [];
  private fps = 60;
  private rate = 0;
  private lastSlow = 0;

  constructor(
    private readonly adapter: SimAdapter,
    private readonly local: PlayerId,
    private readonly actions: { menu(): void; help(): void; jump(p: Vec2): void; menuKey(): string },
  ) {
    const army = adapter.armyOf(local);
    const res = (cls: string, ic: string, label: string, value: HTMLElement, extra?: HTMLElement) =>
      h('div', { class: `res ${cls}` }, h('span', { class: 'res-icon', html: icon(ic as never) }), h('span', { class: 'res-body' }, h('span', { class: 'res-label' }, label), h('span', { class: 'res-line' }, value, extra)));

    const supplyRes = res('supply', 'supply', 'Supply', this.supply, this.supplyRate);
    bindTip(supplyRes, () => ({
      title: 'Supply',
      sub: `${fmtInt(adapter.economy(army).supply)} banked · +${fmtInt(this.rate)} per minute`,
      icon: icon('supply', 'ic-md'),
      body: ['Spent on everything. Earned by your HQ, held strategic points and Supply Depots (double next to oil). Supply trucks haul it home: protect their routes.'],
    }));
    this.powerRes = res('power', 'power', 'Power', this.power, h('span', { class: 'meter' }, this.powerFill));
    bindTip(this.powerRes, () => {
      const p = adapter.economy(army).power;
      const low = p ? p.used > p.produced : false;
      return {
        title: 'Power',
        sub: p ? `${fmtInt(p.used)} used of ${fmtInt(p.produced)} produced` : undefined,
        icon: icon('power', 'ic-md'),
        body: ['Power Plants produce it; most buildings use it.'],
        warn: low ? 'Low power: production runs at half speed and radar and defenses shut off. Build a Power Plant.' : undefined,
      };
    });
    this.cpRes = res('cp', 'cp', 'Command', this.cp, h('span', { class: 'meter' }, this.cpFill));
    bindTip(this.cpRes, () => {
      const c = adapter.economy(army).commandPoints;
      return {
        title: 'Command points',
        sub: `${c.used} of ${c.cap} in use`,
        icon: icon('cp', 'ic-md'),
        body: ['Your army size cap. Every unit costs command points (CP). Each strategic point you hold raises the cap, and a side that is behind gets a little extra.'],
        warn: c.used >= c.cap ? 'At the cap: take more points or lose units before you can train more.' : undefined,
      };
    });
    this.tierRes = h('div', { class: 'res tier' }, h('span', { class: 'res-icon', html: icon('tier') }), h('span', { class: 'res-body' }, h('span', { class: 'res-label' }, 'Tier'), this.tier));
    bindTip(this.tierRes, () => {
      const t = adapter.economy(army).tier;
      return { title: `Tech tier ${t}`, icon: icon('tier', 'ic-md'), body: [TIER_NEXT[t] ?? ''] };
    });

    const help = h('button', { class: 'icon-btn', type: 'button', html: icon('info'), onclick: () => actions.help() });
    tipText(help, 'Field manual', 'Controls, the Morale rule and what counters what.');
    const menu = h('button', { class: 'icon-btn', type: 'button', html: icon('menu'), onclick: () => actions.menu() });
    bindTip(menu, () => ({ title: 'Game menu', keys: [[actions.menuKey(), 'Open'], ['Esc', 'Open (nothing selected)']] }));
    const clock = h('div', { class: 'clock' }, h('span', { html: icon('clock', 'ic-sm') }), this.clock);
    tipText(clock, 'Game time', 'Sudden death starts at 90:00: HQs lose their armor and every side bleeds Morale.');

    this.el = h(
      'div',
      { class: 'hud-topbar' },
      h('div', { class: 'hud-panel res-panel' }, supplyRes, this.powerRes, this.cpRes, this.tierRes),
      h('div', { class: 'hud-panel center-panel' }, this.morale, h('div', { class: 'center-foot' }, this.points, clock)),
      h('div', { class: 'hud-panel right-panel' }, this.partners, this.net, help, menu),
    );
    this.renderPartners();
  }

  private renderPartners(): void {
    const co = this.adapter.coCommanders(this.local);
    const me = this.adapter.slot(this.local);
    if (!co.length) return this.partners.classList.add('hidden');
    setChildren(
      this.partners,
      h('span', { html: icon('team', 'ic-sm') }),
      [me, ...co].filter(Boolean).map((p) => h('span', { class: `partner${p!.id === this.local ? ' me' : ''}`, style: { '--c': p!.color } }, p!.name, p!.role ? h('span', { class: 'partner-role' }, p!.role) : null)),
    );
    tipText(this.partners, 'Shared command', 'You and your co-commanders order one army with one base and economy. Roles (if set) decide who orders what; unassigned roles are open to everyone.');
  }

  update(tick: Tick, dt: number, opts: { showFps: boolean; pingMs?: number }): void {
    const a = this.adapter;
    const army = a.armyOf(this.local);
    const eco = a.economy(army);
    const t = tick / SIM_HZ;
    setText(this.supply, fmtInt(eco.supply));
    setText(this.clock, fmtClock(t));
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

    const now = performance.now();
    if (now - this.lastSlow < SLOW_MS) return;
    this.lastSlow = now;

    // Income per minute over a 20 s window (spending shows as zero, not negative).
    const last = this.samples[this.samples.length - 1];
    if (!last || t - last.t >= 0.5) {
      this.samples.push({ t, v: eco.supply });
      while (this.samples.length > 2 && t - this.samples[0].t > 20) this.samples.shift();
    }
    let gained = 0;
    for (let i = 1; i < this.samples.length; i++) gained += Math.max(0, this.samples[i].v - this.samples[i - 1].v);
    const span = this.samples.length > 1 ? t - this.samples[0].t : 0;
    this.rate = span > 2 ? (gained / span) * 60 : 0;
    setText(this.supplyRate, this.rate >= 1 ? `+${fmtInt(this.rate)}/m` : '');

    if (eco.power) {
      setText(this.power, `${fmtInt(eco.power.used)}/${fmtInt(eco.power.produced)}`);
      setWidth(this.powerFill, eco.power.produced > 0 ? eco.power.used / eco.power.produced : eco.power.used > 0 ? 1 : 0);
      this.powerRes.classList.toggle('warn', eco.power.used > eco.power.produced);
    } else {
      setText(this.power, fmtInt(eco.netPower));
      this.powerRes.classList.toggle('warn', eco.netPower < 0);
    }
    const c = eco.commandPoints;
    setText(this.cp, `${fmtInt(c.used)}/${fmtInt(c.cap)}`);
    setWidth(this.cpFill, c.cap > 0 ? c.used / c.cap : 0);
    this.cpRes.classList.toggle('warn', c.used >= c.cap);
    this.cpRes.classList.toggle('near', c.used < c.cap && c.used >= c.cap * 0.85);
    setText(this.tier, ['', 'I', 'II', 'III'][eco.tier] ?? String(eco.tier));
    this.tierRes.dataset.tier = String(eco.tier);

    this.renderMorale();
    this.renderPoints();

    const parts: string[] = [];
    if (opts.pingMs !== undefined) parts.push(`${Math.round(opts.pingMs)} ms`);
    if (opts.showFps) parts.push(`${this.fps.toFixed(0)} fps`, `T${tick}`);
    setText(this.net, parts.join(' · '));
    this.net.classList.toggle('bad', (opts.pingMs ?? 0) > 250);
  }

  private renderMorale(): void {
    const a = this.adapter;
    const teams = a.teamMorale();
    const myTeam = a.teamOf(this.local);
    const held = new Map<number, number>();
    for (const p of a.points()) if (p.owner >= 0) held.set(a.teamOf(p.owner) ?? -1, (held.get(a.teamOf(p.owner) ?? -1) ?? 0) + 1);
    // Own team first, then by team id.
    teams.sort((x, y) => (x.team === myTeam ? -1 : y.team === myTeam ? 1 : x.team - y.team));
    const key = JSON.stringify(teams.map((x) => [x.team, Math.round(x.morale), x.defeated, held.get(x.team) ?? 0]));
    if (key === this.moraleKey) return;
    const firstRender = this.moraleKey === '';
    this.moraleKey = key;
    const lead = Math.max(0, ...held.values());
    if (firstRender || this.morale.childElementCount !== teams.length) {
      setChildren(
        this.morale,
        teams.map((tm, i) => {
          const chip = h(
            'div',
            { class: `morale${tm.team === myTeam ? ' mine' : ''}${i === 1 && teams.length === 2 ? ' right' : ''}`, style: { '--team-color': tm.color }, dataset: { team: String(tm.team) } },
            h('span', { class: 'morale-name' }, tm.team === myTeam ? 'Our Morale' : teams.length === 2 ? 'Enemy' : tm.players.map((p) => p.name).join(' · ')),
            h('span', { class: 'morale-value' }),
            h('span', { class: 'morale-bar' }, h('span', { class: 'morale-fill' })),
            h('span', { class: 'morale-drain' }),
          );
          bindTip(chip, () => {
            const t = a.teamMorale().find((x) => x.team === tm.team);
            const h2 = held.get(tm.team) ?? 0;
            return {
              title: `${tm.team === myTeam ? 'Our' : `Team ${tm.team + 1}`} Morale`,
              sub: tm.players.map((p) => p.name).join(', '),
              icon: icon('morale', 'ic-md'),
              body: [
                'Each side starts with 1,000. A side holding fewer strategic points than the leader loses Morale every second, and every unit lost costs a little. At zero the side breaks and loses.',
                'Below 25% the side is shaken: its pinned troops recover more slowly.',
              ],
              rows: [
                { k: 'Morale', v: `${fmtInt(t?.morale ?? 0)} / ${fmtInt(t?.max ?? 1000)}` },
                { k: 'Points held', v: String(h2) },
              ],
            };
          });
          return chip;
        }),
      );
    }
    teams.forEach((tm, i) => {
      const chip = this.morale.children[i] as HTMLElement;
      const frac = tm.max > 0 ? Math.max(0, Math.min(1, tm.morale / tm.max)) : 0;
      setText(chip.querySelector('.morale-value')!, fmtInt(tm.morale));
      setWidth(chip.querySelector('.morale-fill')!, frac);
      const behind = lead - (held.get(tm.team) ?? 0);
      setText(chip.querySelector('.morale-drain')!, !tm.defeated && behind > 0 ? `▼ ${behind} pt${behind > 1 ? 's' : ''} behind` : '');
      chip.classList.toggle('low', frac < 0.25 && !tm.defeated);
      chip.classList.toggle('draining', behind > 0 && !tm.defeated);
      chip.classList.toggle('defeated', tm.defeated);
    });
  }

  private renderPoints(): void {
    const pts = this.adapter.points().sort((p, q) => p.pos.x - q.pos.x || p.pos.z - q.pos.z);
    const key = JSON.stringify(pts.map((p) => [p.id, p.owner, p.capturer ?? -1, Math.round((p.progress ?? 0) * 20)]));
    if (key === this.pointsKey) return;
    const rebuild = this.points.childElementCount !== pts.length;
    this.pointsKey = key;
    if (rebuild) {
      setChildren(
        this.points,
        pts.map((p, i) => {
          const el = h('button', { class: 'pt', type: 'button', dataset: { id: String(p.id) }, onclick: () => this.actions.jump(p.pos) }, h('span', { class: 'pt-ring' }), h('span', { class: 'pt-core' }));
          bindTip(el, () => {
            const cur = this.adapter.points().find((x) => x.id === p.id);
            const owner = cur && cur.owner >= 0 ? this.adapter.slot(cur.owner) : undefined;
            const capping = cur?.capturer !== undefined && cur.capturer >= 0 && Math.abs(cur.progress ?? 0) > 0 && Math.abs(cur.progress ?? 0) < 1 ? this.adapter.slot(cur.capturer) : undefined;
            return {
              title: cur?.name ?? `Point ${String.fromCharCode(65 + i)}`,
              sub: owner ? `Held by ${owner.name}` : 'Neutral',
              icon: icon('point', 'ic-md'),
              body: ['Stand ground units on it to capture. Holding more points than the enemy drains their Morale and raises your command cap.', capping ? `${capping.name} is capturing: ${Math.round(Math.abs(cur!.progress ?? 0) * 100)}%` : ''].filter(Boolean),
              keys: [['Click', 'Jump camera']],
            };
          });
          return el;
        }),
      );
    }
    pts.forEach((p, i) => {
      const el = this.points.children[i] as HTMLElement;
      const color = p.owner >= 0 ? this.adapter.colorOf(p.owner) : '';
      const prog = Math.abs(p.progress ?? 0);
      const capping = p.capturer !== undefined && p.capturer >= 0 && prog > 0 && prog < 1;
      el.style.setProperty('--owner', color || 'transparent');
      el.style.setProperty('--cap', capping ? this.adapter.colorOf(p.capturer!) : 'transparent');
      el.style.setProperty('--prog', capping ? String(prog) : '0');
      el.classList.toggle('owned', p.owner >= 0);
      el.classList.toggle('ours', p.owner >= 0 && this.adapter.isAlly(p.owner, this.local));
    });
  }
}
