export type Difficulty = 'easy' | 'normal' | 'hard';

/** How each difficulty plays. Nobody cheats: Hard just decides faster and better. */
export interface AiParams {
  /** Seconds of game time between decisions. */
  think: number;
  /** Units queued per factory. */
  queue: number;
  engineers: number;
  /** Earliest game second to build the radar (Tier 2) and the Strategic Command (Tier 3). */
  radarAt: number;
  strategicAt: number;
  /** Supply depots to build (on nodes first). */
  depots: number;
  /** Build counters to what it has seen of the enemy army. */
  counters: boolean;
  /** Use unit abilities (barrage, smoke, sprint, entrench, ambush). */
  abilities: boolean;
  /** Hold captured points with drawn frontlines. */
  lines: boolean;
  /** Chance an attack goes in via a flanking waypoint. */
  flank: number;
  /** Game second raids on supply trucks, depots and power begin (Infinity = never). */
  raidFrom: number;
  raiders: number;
  /** Pull back from fights it is losing. */
  retreat: boolean;
  /** Damaged vehicles fall back; focus fire. */
  micro: boolean;
  superweapon: boolean;
  /** Use transport ships/helicopters for points ground units can't reach. */
  transports: boolean;
  scout: boolean;
  /** Task forces in the field at once. */
  forces: number;
  /** Strength a force wants relative to what it knows defends its objective. */
  overmatch: number;
  /** Seconds before the AI starts building (reaction time). */
  startDelay: number;
}

export const AI_PARAMS: Record<Difficulty, AiParams> = {
  easy: {
    think: 4,
    queue: 1,
    engineers: 1,
    radarAt: 720,
    strategicAt: Infinity,
    depots: 1,
    counters: false,
    abilities: false,
    lines: false,
    flank: 0,
    raidFrom: Infinity,
    raiders: 0,
    retreat: false,
    micro: false,
    superweapon: false,
    transports: false,
    scout: false,
    forces: 1,
    overmatch: 0.8,
    startDelay: 25,
  },
  normal: {
    think: 2,
    queue: 2,
    engineers: 2,
    radarAt: 300,
    strategicAt: 1200,
    depots: 2,
    counters: true,
    abilities: true,
    lines: true,
    flank: 0.4,
    raidFrom: 720,
    raiders: 2,
    retreat: true,
    micro: false,
    superweapon: true,
    transports: true,
    scout: true,
    forces: 3,
    overmatch: 1.2,
    startDelay: 6,
  },
  hard: {
    think: 1,
    queue: 3,
    engineers: 3,
    radarAt: 240,
    strategicAt: 960,
    depots: 3,
    counters: true,
    abilities: true,
    lines: true,
    flank: 0.7,
    raidFrom: 480,
    raiders: 3,
    retreat: true,
    micro: true,
    superweapon: true,
    transports: true,
    scout: true,
    forces: 3,
    overmatch: 1.25,
    startDelay: 0,
  },
};
