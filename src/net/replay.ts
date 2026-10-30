import type { Command, Turn } from '../shared/commands';
import type { MatchSetup, PlayerId, Tick } from '../shared/types';
import type { NetSession } from './session';

/** All commands of a match (only turns that had any) plus what is needed to rebuild it. */
export interface CommandLog {
  matchId: string;
  setup: MatchSetup;
  turnTicks: number;
  /** First tick not covered by the log. */
  endTick: Tick;
  turns: Turn[];
  /** Local state hashes [tick, hash], used to verify playback. */
  hashes: [Tick, number][];
}

export interface ReplayFile extends CommandLog {
  format: 'frontline-replay';
  version: 1;
  /** ISO timestamp, informational only. */
  savedAt: string;
}

export function toReplay(log: CommandLog, savedAt = new Date().toISOString()): ReplayFile {
  return { format: 'frontline-replay', version: 1, savedAt, ...log };
}

export function serializeReplay(log: CommandLog): string {
  return JSON.stringify(toReplay(log));
}

/** Parse and validate a replay file. Throws with a readable message on bad input. */
export function parseReplay(json: string): ReplayFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Not a replay file (invalid JSON).');
  }
  const r = data as Partial<ReplayFile>;
  if (r?.format !== 'frontline-replay') throw new Error('Not a Frontline replay file.');
  if (r.version !== 1) throw new Error(`Unsupported replay version ${String(r.version)}.`);
  if (!r.setup || !Array.isArray(r.setup.players) || !Array.isArray(r.turns) || typeof r.endTick !== 'number') {
    throw new Error('Replay file is incomplete.');
  }
  return { ...r, hashes: r.hashes ?? [] } as ReplayFile;
}

/** Browser only: offer the replay as a download, e.g. `frontline-2026-10-29.replay.json`. */
export function downloadReplay(log: CommandLog, filename?: string): void {
  const file = toReplay(log);
  const name = filename ?? `frontline-${file.savedAt.slice(0, 19).replace(/[:T]/g, '-')}.replay.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Plays a recorded command log back. Run a normal Match with `replay.setup` and this as the
 * NetSession; `pollTurn` returns null once the recording ends. Local input is ignored.
 * `mismatch` is set if the playback hash differs from the recorded one (a determinism bug or
 * a replay from an incompatible build).
 */
export class ReplaySession implements NetSession {
  readonly localPlayer: PlayerId;
  readonly setup: MatchSetup;
  readonly endTick: Tick;
  mismatch: { tick: Tick; expected: number; actual: number } | null = null;
  private readonly byTick = new Map<Tick, Turn['commands']>();
  private readonly expected = new Map<Tick, number>();

  /** `viewAs` picks whose perspective (fog, camera spawn) the replay is shown from. */
  constructor(replay: CommandLog, viewAs?: PlayerId) {
    this.setup = replay.setup;
    this.endTick = replay.endTick;
    this.localPlayer = viewAs ?? replay.setup.players[0]?.id ?? 0;
    for (const t of replay.turns) this.byTick.set(t.tick, t.commands);
    for (const [tick, h] of replay.hashes) this.expected.set(tick, h);
  }

  submit(_cmd: Command): void {}

  pollTurn(tick: Tick): Turn | null {
    if (tick >= this.endTick) return null;
    return { tick, commands: this.byTick.get(tick) ?? [] };
  }

  reportHash(tick: Tick, hash: number): void {
    const want = this.expected.get(tick);
    if (want !== undefined && want !== hash && !this.mismatch) {
      this.mismatch = { tick, expected: want, actual: hash };
      console.error(`[net] replay diverged at tick ${tick}`);
    }
  }

  dispose(): void {}
}
