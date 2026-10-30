import type { AudioEngine, Voice } from './engine';

export type MusicState = 'off' | 'menu' | 'calm' | 'battle' | 'victory' | 'defeat';

const LAMENT = 'sounds/music/war_lament_01.mp3';
const WAR = 'sounds/music/call_to_war_01.mp3';

/** Which track each state plays and how loud (before the music bus volume). */
const STATES: Record<Exclude<MusicState, 'off'>, { track: string; gain: number }> = {
  menu: { track: LAMENT, gain: 0.6 },
  calm: { track: LAMENT, gain: 0.28 },
  battle: { track: WAR, gain: 0.5 },
  victory: { track: WAR, gain: 0.6 },
  defeat: { track: LAMENT, gain: 0.55 },
};

const CROSSFADE = 3;

/**
 * Recent-combat meter that drives calm/battle music. Events add weight; it decays exponentially.
 * Pure (no Web Audio) so it can be tested.
 */
export class Intensity {
  value = 0;
  constructor(private readonly halfLife = 12) {}

  add(w: number): void {
    this.value += w;
  }

  decay(dt: number): void {
    this.value *= Math.pow(0.5, dt / this.halfLife);
  }
}

/** Intensity thresholds with hysteresis so music doesn't flap between states. */
export const BATTLE_ENTER = 14;
export const BATTLE_EXIT = 4;
/** Minimum seconds in battle before dropping back to calm. */
export const BATTLE_MIN_HOLD = 25;

export function nextCombatState(cur: 'calm' | 'battle', intensity: number, secondsInState: number): 'calm' | 'battle' {
  if (cur === 'calm') return intensity >= BATTLE_ENTER ? 'battle' : 'calm';
  return intensity < BATTLE_EXIT && secondsInState >= BATTLE_MIN_HOLD ? 'calm' : 'battle';
}

/** Plays one looping track at a time and crossfades between states. */
export class MusicDirector {
  state: MusicState = 'off';
  private voice?: Voice;
  private track?: string;
  private changedAt = 0;
  private wanted = 0;

  constructor(private readonly eng: AudioEngine) {}

  /** Seconds since the last state change. */
  get inState(): number {
    return this.eng.now - this.changedAt;
  }

  set(state: MusicState): void {
    if (state === this.state) return;
    this.state = state;
    this.changedAt = this.eng.now;
    const req = ++this.wanted;
    if (state === 'off') {
      this.voice?.stop(CROSSFADE);
      this.voice = undefined;
      this.track = undefined;
      return;
    }
    const { track, gain } = STATES[state];
    if (track === this.track && this.voice && !this.voice.ended) {
      this.voice.set(gain, undefined, undefined, undefined, CROSSFADE / 3);
      return;
    }
    void this.eng.load(track).then((buf) => {
      // Ignore if another state change happened while loading, or audio isn't unlocked yet.
      if (!buf || req !== this.wanted) return;
      if (!this.eng.running) {
        this.eng.onceRunning(() => this.restart());
        return;
      }
      this.voice?.stop(CROSSFADE);
      // Re-entering a track mid-match starts somewhere in it, so it doesn't always open the same way.
      const offset = state === 'calm' || state === 'battle' ? Math.random() * buf.duration * 0.6 : 0;
      this.voice = this.eng.play(buf, { bus: 'music', gain, loop: true, fadeIn: CROSSFADE, offset }) ?? undefined;
      this.track = this.voice ? track : undefined;
    });
  }

  /** Start the current state again (e.g. after the first user gesture unlocked audio). */
  restart(): void {
    const s = this.state;
    if (this.voice && !this.voice.ended) return;
    this.state = 'off';
    this.track = undefined;
    this.set(s);
  }
}
