// Runs a whole match with AIs in every slot and no renderer: for balance tests and tuning.
// Commands go through a fixed input delay like lockstep, so AIs react as they would online.

import type { Command, PlayerCommand } from '../shared/commands';
import type { MapDef } from '../shared/data';
import type { MatchSetup, PlayerId, TeamId } from '../shared/types';
import { SIM_HZ } from '../shared/types';
import { Simulation } from '../sim/simulation';
import type { SimContent } from '../sim/world';
import { SkirmishAi } from './skirmish';

export interface HeadlessResult {
  winner: TeamId | null;
  /** Game seconds played. */
  seconds: number;
  morale: Record<number, number>;
  /** Units produced and lost per player. */
  produced: Record<number, number>;
  lost: Record<number, number>;
  /** Every unit type that was produced, per player. */
  types: Record<number, Record<string, number>>;
  /** Unit types lost, per player. */
  lostTypes: Record<number, Record<string, number>>;
  sim: Simulation;
}

export interface HeadlessOptions {
  /** Stop after this many game seconds (default 100 minutes). */
  maxSeconds?: number;
  /** Ticks between a command being issued and applied (default 3, like lockstep). */
  delay?: number;
  /** Called every simulated second, e.g. to apply a handicap. */
  everySecond?: (sim: Simulation, seconds: number) => void;
  seed?: number;
}

export function runHeadless(setup: MatchSetup, content: SimContent, opts: HeadlessOptions = {}): HeadlessResult {
  const sim = new Simulation(setup, content);
  const map = content.map as MapDef;
  const delay = opts.delay ?? 3;
  const pending: { at: number; pc: PlayerCommand }[] = [];
  const ais = setup.players.map(
    (p) =>
      new SkirmishAi(p.id, setup, sim, map, (cmd: Command, player: PlayerId) => pending.push({ at: sim.tick + delay, pc: { player, cmd } }), opts.seed ?? 1),
  );
  const maxTicks = (opts.maxSeconds ?? 6000) * SIM_HZ;
  const produced: Record<number, number> = {};
  const lost: Record<number, number> = {};
  const types: Record<number, Record<string, number>> = {};
  const lostTypes: Record<number, Record<string, number>> = {};
  for (const p of setup.players) {
    produced[p.id] = 0;
    lost[p.id] = 0;
    types[p.id] = {};
    lostTypes[p.id] = {};
  }
  const owners = new Map<number, { owner: PlayerId; unit: boolean; type: string }>();
  for (const e of sim.entities()) owners.set(e.id, { owner: e.owner, unit: e.kind === 'unit', type: e.type });
  while (sim.tick < maxTicks && sim.winner === null) {
    for (const ai of ais) ai.update();
    const now: PlayerCommand[] = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].at <= sim.tick) {
        now.push(pending[i].pc);
        pending.splice(i, 1);
      }
    }
    now.reverse();
    const events = sim.step(now);
    for (const ev of events) {
      if (ev.type === 'spawned') {
        const e = sim.get(ev.id);
        if (e) owners.set(e.id, { owner: e.owner, unit: e.kind === 'unit' && e.type !== 'supply_truck', type: e.type });
      } else if (ev.type === 'produced') {
        const u = sim.get(ev.unit);
        if (u) {
          produced[u.owner]++;
          types[u.owner][u.type] = (types[u.owner][u.type] ?? 0) + 1;
        }
      } else if (ev.type === 'died') {
        const o = owners.get(ev.id);
        if (o?.unit && o.owner >= 0) {
          lost[o.owner] = (lost[o.owner] ?? 0) + 1;
          lostTypes[o.owner][o.type] = (lostTypes[o.owner][o.type] ?? 0) + 1;
        }
      }
    }
    if (opts.everySecond && sim.tick % SIM_HZ === 0) opts.everySecond(sim, sim.tick / SIM_HZ);
  }
  const morale: Record<number, number> = {};
  for (const t of sim.world.teams.values()) morale[t.id] = Math.round(t.morale);
  return { winner: sim.winner, seconds: sim.gameTick / SIM_HZ, morale, produced, lost, types, lostTypes, sim };
}
