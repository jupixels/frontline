import type { EntityState } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, Vec2 } from '../shared/types';
import { TutorialPanel, type UiApp } from '../ui';
import type { IconId } from '../ui/icons';
import type { Match } from './match';

interface Step {
  icon: IconId;
  title: string;
  body(k: Record<string, string>): string[];
  /** Reading steps wait for Continue. */
  manual?: boolean;
  /** Called once when the step starts. */
  enter?(t: Tutorial): void;
  /** Live check; returns [done, progress text]. */
  check?(t: Tutorial): [boolean, string?];
}

const STEPS: Step[] = [
  {
    icon: 'tutorial',
    title: 'Welcome, commander',
    manual: true,
    body: () => [
      'This short drill covers everything you need for a real match: the camera, orders, building, capturing points, Morale, frontlines and abilities.',
      'The enemy at the far corner will not attack. Take your time.',
    ],
  },
  {
    icon: 'eye',
    title: 'Move the camera',
    body: (k) => [`Pan with [[${k.panUp}]] [[${k.panLeft}]] [[${k.panDown}]] [[${k.panRight}]], the arrow keys or the screen edges. Zoom with the mouse wheel and hold the middle button to rotate.`, 'Click the minimap to jump anywhere.'],
    enter: (t) => t.markCamera(),
    check: (t) => {
      const moved = t.cameraMoved();
      return [moved.pan && moved.zoom, `${moved.pan ? '✓' : '○'} pan   ${moved.zoom ? '✓' : '○'} zoom`];
    },
  },
  {
    icon: 'army',
    title: 'Select your troops',
    body: (k) => [`Drag a box around your rifle squads with the left mouse button. Double-click a soldier to select every unit of that type on screen, or press [[${k.selectArmy}]] for your whole army.`],
    enter: (t) => t.lookAtArmy(),
    check: (t) => {
      const n = t.selected('rifleman');
      return [n >= 4, `${Math.min(n, 4)} / 4 riflemen selected`];
    },
  },
  {
    icon: 'move',
    title: 'Give an order',
    body: () => ['Right-click the ground to move there. Right-click near the strategic point the camera shows (the diamond, also pinged on the minimap).', 'Hold Shift to queue several waypoints.'],
    enter: (t) => t.showTarget(),
    check: (t) => {
      const d = t.nearestToTarget('rifleman');
      return [d < 30, d < Infinity ? `${Math.round(d)} m to go` : undefined];
    },
  },
  {
    icon: 'point',
    title: 'Capture the point',
    body: () => ['Stand ground units on a point to capture it. The ring fills in your color; more units capture faster. Enemy points must be neutralized first.', 'The diamonds in the top bar track every point on the map.'],
    check: (t) => {
      const p = t.targetPoint();
      if (!p) return [true];
      const prog = Math.round(Math.abs(t.capture(p.id)?.progress ?? 0) * 100);
      return [p.owner === t.me, p.owner === t.me ? 'Captured' : `Capturing ${prog}%`];
    },
  },
  {
    icon: 'morale',
    title: 'Morale wins the war',
    manual: true,
    body: () => [
      'Look at the top bar. Each side starts with **1,000 Morale**. Whoever holds fewer points than the leader loses Morale every second, and every unit lost costs a little more.',
      'You now hold more points than the enemy, so their bar is draining. At zero, a side breaks and loses. Below 25% it is shaken: pinned troops recover slowly.',
    ],
  },
  {
    icon: 'build',
    title: 'Build a barracks',
    body: (k) => [`Press [[${k.idleEngineer}]] to select your idle engineer, then [[${k.build}]] for the construction menu and [[${k.slot1}]] for the Barracks.`, 'Left-click a clear spot near your HQ to place it. Hover any button for its cost, counters and hotkey.'],
    check: (t) => [t.owns('barracks'), t.owns('barracks') ? 'Construction started' : undefined],
  },
  {
    icon: 'production',
    title: 'Train infantry',
    body: (k) => [`Construction takes a little while; the tray on the left shows its progress. When it is done, select the Barracks and press [[${k.slot1}]] to train a Rifle Squad.`, 'Shift trains five; right-clicking a button cancels one. New units walk to the rally point.'],
    check: (t) => [t.trained, t.ownsDone('barracks') ? (t.queued('barracks') ? 'In production' : 'Barracks ready: train a squad') : 'Building…'],
  },
  {
    icon: 'line',
    title: 'Draw a frontline',
    body: (k) => [`Select your riflemen, then hold [[${k.drawLine}]] and drag a line across the field. They spread out along it by role, face the enemy and hold it.`, `[[${k.advanceLine}]] pushes the whole line forward later.`],
    check: (t) => [t.hasLine(), t.hasLine() ? 'Line formed' : undefined],
  },
  {
    icon: 'smoke',
    title: 'Use an ability',
    body: (k) => [`Abilities sit on the command card. With riflemen selected, press [[${k.slot1}]] for Smoke (then click the ground), or try Sprint and Entrench.`, 'A dark sweep on the button shows the cooldown.'],
    check: (t) => [t.usedAbility, t.usedAbility ? 'Nice' : undefined],
  },
  {
    icon: 'trophy',
    title: 'Training complete',
    manual: true,
    body: (k) => [
      'You know the essentials. In a real match, expand with Supply Depots and Power Plants, tech up with a Radar Station, and mix unit types: everything has a counter.',
      `Press [[${k.fieldManual}]] any time for the field manual. Finish here, or keep playing: capture the other points and break the enemy.`,
    ],
  },
];

/**
 * Basic training. Runs on the tutorial map against a passive opponent; watches the sim and the
 * player's selection to advance through the steps, and coaches through a HUD panel.
 */
export class Tutorial {
  readonly panel: TutorialPanel;
  readonly me: number;
  private step = 0;
  private done = false;
  private timer: number;
  private cam0 = { x: 0, z: 0, d: 0 };
  private target: EntityId | null = null;
  trained = false;
  usedAbility = false;

  constructor(
    private readonly match: Match,
    app: UiApp,
  ) {
    this.me = match.ui.adapter.armyOf(match.ui.input.localPlayer);
    this.panel = new TutorialPanel({ next: () => this.next(), skip: () => this.next(), quit: () => app.leaveMatch() });
    match.ui.mount(this.panel.el);
    match.onEvents = (ev) => this.onEvents(ev);
    this.timer = window.setInterval(() => this.tick(), 200);
    this.enter();
  }

  private get keys(): Record<string, string> {
    return this.match.ui.keyLabels();
  }

  private enter(): void {
    this.done = false;
    STEPS[this.step].enter?.(this);
    this.tick();
  }

  private next(): void {
    if (this.step >= STEPS.length - 1) {
      this.finish();
      return;
    }
    this.step++;
    this.enter();
  }

  private finish(): void {
    clearInterval(this.timer);
    const team = this.match.ui.adapter.teamOf(this.me) ?? 0;
    this.match.ui.endMatch(team, 'Basic training complete');
  }

  private tick(): void {
    const s = STEPS[this.step];
    let progress: string | undefined;
    if (s.check && !this.done) {
      const [ok, text] = s.check(this);
      progress = text;
      if (ok) {
        this.done = true;
        // Short beat to read the check mark, then move on.
        window.setTimeout(() => {
          if (STEPS[this.step] === s) this.next();
        }, 1300);
      }
    } else if (this.done) progress = 'Done';
    this.panel.show({ index: this.step, total: STEPS.length, icon: s.icon, title: s.title, body: s.body(this.keys), progress, manual: s.manual, done: this.done, last: this.step === STEPS.length - 1 });
  }

  private onEvents(events: SimEvent[]): void {
    const sim = this.match.sim;
    for (const e of events) {
      if (e.type === 'produced' && sim.get(e.factory)?.type === 'barracks' && sim.get(e.factory)?.owner === this.me) this.trained = true;
      if (e.type === 'abilityUsed' && sim.get(e.id)?.owner === this.me) this.usedAbility = true;
    }
  }

  // --- checks used by the steps

  private own(type?: string): EntityState[] {
    return [...this.match.sim.entities()].filter((e) => e.owner === this.me && (!type || e.type === type));
  }

  markCamera(): void {
    const c = this.match.renderer.cam;
    this.cam0 = { x: c.target.x, z: c.target.z, d: c.viewDistance };
  }

  cameraMoved(): { pan: boolean; zoom: boolean } {
    const c = this.match.renderer.cam;
    return { pan: Math.hypot(c.target.x - this.cam0.x, c.target.z - this.cam0.z) > 40, zoom: Math.abs(c.viewDistance - this.cam0.d) > 15 };
  }

  lookAtArmy(): void {
    const r = this.own('rifleman');
    if (!r.length) return;
    const x = r.reduce((s, e) => s + e.pos.x, 0) / r.length;
    const z = r.reduce((s, e) => s + e.pos.z, 0) / r.length;
    this.match.renderer.cam.lookAt(x, z);
  }

  selected(type: string): number {
    let n = 0;
    for (const id of this.match.ui.input.selection) if (this.match.sim.get(id)?.type === type) n++;
    return n;
  }

  /** The neutral point closest to our HQ. */
  targetPoint(): EntityState | undefined {
    const sim = this.match.sim;
    if (this.target === null) {
      const hq = this.own('hq')[0];
      const pts = [...sim.entities()].filter((e) => e.kind === 'point');
      pts.sort((a, b) => dist(a.pos, hq?.pos ?? a.pos) - dist(b.pos, hq?.pos ?? b.pos));
      this.target = pts[0]?.id ?? -1;
    }
    return sim.get(this.target);
  }

  showTarget(): void {
    const p = this.targetPoint();
    if (!p) return;
    this.match.renderer.cam.lookAt(p.pos.x, p.pos.z);
    this.match.ui.ping(p.pos);
    window.setTimeout(() => this.match.ui.ping(p.pos), 1500);
  }

  nearestToTarget(type: string): number {
    const p = this.targetPoint();
    if (!p) return 0;
    return Math.min(Infinity, ...this.own(type).map((e) => dist(e.pos, p.pos)));
  }

  capture(id: EntityId): { progress: number } | undefined {
    return this.match.sim.capture(id);
  }

  owns(type: string): boolean {
    return this.own(type).length > 0;
  }

  ownsDone(type: string): boolean {
    return this.own(type).some((e) => this.match.sim.buildProgress(e.id) >= 1);
  }

  queued(type: string): boolean {
    return this.own(type).some((e) => this.match.sim.queue(e.id).length > 0);
  }

  hasLine(): boolean {
    return this.match.sim.lines(this.me).some((l) => l.owner === this.me);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.match.onEvents = null;
    this.panel.dispose();
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
