import type { Command } from '../shared/commands';
import type { SimView, SimViewExt } from '../shared/entities';
import type { MatchSetup, PlayerId, Vec2 } from '../shared/types';

/**
 * Stand-in opponent until the skirmish AI workstream (Phase 2) lands: builds a barracks, keeps
 * it producing, and periodically attack-moves its army toward the nearest enemy unit or point.
 * Runs only on the peer that controls the AI slot, and issues normal Commands.
 */
export class PlaceholderAi {
  private timer = 0;
  private readonly period: number;

  constructor(
    private readonly player: PlayerId,
    private readonly setup: MatchSetup,
    private readonly sim: SimView & SimViewExt,
    private readonly issue: (cmd: Command, player: PlayerId) => void,
  ) {
    const difficulty = setup.players.find((p) => p.id === player)?.aiDifficulty ?? 'normal';
    this.period = difficulty === 'easy' ? 40 : difficulty === 'hard' ? 15 : 25;
    this.timer = this.period * 0.5;
  }

  update(dt: number): void {
    this.timer += dt;
    if (this.timer < this.period) return;
    this.timer = 0;
    this.economy();
    this.attack();
  }

  private mine() {
    return [...this.sim.entities()].filter((e) => e.owner === this.player);
  }

  private economy(): void {
    const mine = this.mine();
    const builder = mine.find((e) => e.type === 'engineer');
    const hq = mine.find((e) => e.type === 'hq');
    const structures = new Set(mine.filter((e) => e.kind === 'structure').map((e) => e.type));
    if (builder && hq) {
      for (const s of ['barracks', 'power_plant', 'war_factory']) {
        if (structures.has(s) || !this.sim.buildable(this.player).includes(s)) continue;
        const at = this.findSpot(s, hq.pos);
        if (at) this.issue({ type: 'build', builder: builder.id, structure: s, at, rotation: 0 }, this.player);
        break;
      }
    }
    for (const f of mine) {
      if (f.kind !== 'structure' || this.sim.buildProgress(f.id) < 1 || this.sim.queue(f.id).length > 1) continue;
      const options = this.sim.producible(f.id).filter((u) => u !== 'engineer' && u !== 'supply_truck');
      if (options.length) this.issue({ type: 'produce', factory: f.id, unit: options[Math.floor(Math.random() * options.length)], count: 2 }, this.player);
    }
  }

  private findSpot(structure: string, near: Vec2): Vec2 | null {
    for (let r = 30; r <= 90; r += 15) {
      for (let a = 0; a < 8; a++) {
        const at = { x: near.x + Math.cos(a * 0.785) * r, z: near.z + Math.sin(a * 0.785) * r };
        if (this.sim.canPlace(this.player, structure, at, 0)) return at;
      }
    }
    return null;
  }

  private attack(): void {
    const army = this.mine().filter((e) => e.kind === 'unit' && e.type !== 'engineer' && e.type !== 'supply_truck');
    if (army.length < 4) return;
    const team = this.setup.players.find((p) => p.id === this.player)?.team;
    const c = army.reduce((a, e) => ({ x: a.x + e.pos.x / army.length, z: a.z + e.pos.z / army.length }), { x: 0, z: 0 });
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (const e of this.sim.entities()) {
      const owner = this.setup.players.find((p) => p.id === e.owner);
      const hostile = e.kind === 'point' ? e.owner !== this.player : owner && owner.team !== team;
      if (!hostile) continue;
      const d = (e.pos.x - c.x) ** 2 + (e.pos.z - c.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = e.pos;
      }
    }
    if (best) this.issue({ type: 'move', units: army.map((e) => e.id), target: { x: best.x, z: best.z }, attackMove: true }, this.player);
  }
}
