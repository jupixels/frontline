import type { EntityState, FogView, SimView } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, PlayerId, TeamId, Vec2 } from '../shared/types';
import {
  ALL_SOUNDS,
  SOUNDS,
  filesOf,
  structureSelectLine,
  unitAudio,
  voiceLine,
  weaponAudio,
  type SoundDef,
  type SoundId,
  type UiSound,
  type UnitAudioLookup,
} from './bank';
import { audioEngine, type Voice } from './engine';
import { BATTLE_ENTER, Intensity, MusicDirector, nextCombatState, type MusicState } from './music';
import { spatialize, type Listener } from './spatial';

export type { Bus, AudioSettings } from './settings';
export { getAudioSettings, setVolume, getVolume, setMuted, isMuted, toggleMuted, onAudioSettingsChange } from './settings';
export { SOUND_CREDITS, SOUND_CREDITS_CC0 } from './credits';
export type { MusicState } from './music';

/** Engine loops kept alive at once (closest/loudest vehicles win). */
const MAX_LOOPS = 8;
/** Minimum gap between unit voice responses (select/order). */
const VOICE_GAP = 1.6;
/** Minimum gap between repeated alerts of the same kind. */
const ALERT_GAP: Record<string, number> = { underAttack: 15, captured: 4, produced: 2.5, lost: 10 };

interface Known {
  type: string;
  kind: EntityState['kind'];
  owner: PlayerId;
  x: number;
  z: number;
}

interface Loop {
  voice: Voice;
  sound: SoundId;
}

const rand = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

let director: MusicDirector | undefined;
/** Page-wide music player, shared by menu and matches. */
export function music(): MusicDirector {
  return (director ??= new MusicDirector(audioEngine()));
}

/** Menu screens: start the menu theme (plays once audio is unlocked by a click/key). */
export function playMenuMusic(): void {
  music().set('menu');
}

export function setMusicState(state: MusicState): void {
  music().set(state);
}

/** UI feedback for menus and HUD buttons; usable without a match. */
export function uiSound(kind: UiSound): void {
  playFlat(`ui_${kind}` as SoundId);
}

const lastStart = new Map<SoundId, number>();
const active = new Map<SoundId, Voice[]>();

interface PlayExtra {
  gain?: number;
  rate?: number;
  delay?: number;
  pan?: number;
}

/**
 * Plays a bank sound with variants, randomization, cooldown and per-sound voice limiting.
 * `listener` + `at` make it positional; otherwise it plays flat.
 */
function playSound(id: SoundId, listener?: Listener, at?: Vec2, x: PlayExtra = {}): Voice | null {
  const eng = audioEngine();
  if (!eng.running) return null;
  const def: SoundDef = SOUNDS[id];
  const now = eng.now;
  const last = lastStart.get(id);
  if (last !== undefined && now - last < (def.cooldown ?? 0.04)) return null;

  let gain = def.volume * (x.gain ?? 1) * rand(def.volVary ?? 0.1);
  let pan = x.pan;
  let cutoff: number | undefined;
  let files = def.files;
  if (!def.flat && listener && at) {
    const s = spatialize(listener, at.x, at.z, def.range ?? 250);
    if (s.gain < 0.01) return null;
    gain *= s.gain;
    pan = s.pan;
    cutoff = s.cutoff;
    if (def.far && s.dist > (def.farFrom ?? 80)) files = def.far;
  }

  // Per-sound voice limit: steal the quietest instance if the new one is louder.
  const list = (active.get(id) ?? []).filter((v) => !v.ended && v.endsAt > now);
  if (list.length >= (def.maxVoices ?? 4)) {
    let q = list[0];
    for (const v of list) if (v.gain < q.gain) q = v;
    if (q.gain >= gain) return null;
    q.stop(0.04);
    list.splice(list.indexOf(q), 1);
  }

  const buf = eng.peek(pick(files));
  if (!buf) return null; // still loading (or failed); skip rather than play late
  const v = eng.play(buf, {
    bus: def.bus ?? 'sfx',
    gain,
    rate: (def.rate ?? 1) * (x.rate ?? 1) * rand(def.vary ?? 0.05),
    pan,
    cutoff,
    delay: x.delay,
    offset: def.offsetMax !== undefined ? Math.random() * def.offsetMax : undefined,
    duration: def.duration,
  });
  if (!v) return null;
  lastStart.set(id, now);
  list.push(v);
  active.set(id, list);
  if (def.duck && gain > def.volume * 0.35) eng.duckMusic(def.duck * Math.min(1, gain / def.volume));
  return v;
}

/** The sim's fog of war, when the view offers one (Simulation implements SimViewExt). */
function fogOf(view?: SimView): FogView | undefined {
  return view && 'fog' in view ? (view as SimView & { fog: FogView }).fog : undefined;
}

function playFlat(id: SoundId, x?: PlayExtra): Voice | null {
  return playSound(id, undefined, undefined, x);
}

export interface AudioManagerOptions {
  /** The local player's team, to tell victory from defeat. */
  team?: TeamId;
  /** Unit data (data/units.json) for guessing sounds of unit types the bank doesn't list. */
  units?: UnitAudioLookup;
}

/**
 * Match audio: positional weapon/explosion/engine sounds from SimEvents + SimView, unit voices,
 * alerts and music states. Never touches game state.
 *
 * Per frame the match loop calls `setListener(...)` and `update(view, dt)`; per sim step it calls
 * `handleEvents(events, view)`.
 */
export class AudioManager {
  private readonly eng = audioEngine();
  private readonly music = music();
  private listener: Listener = { x: 0, z: 0, zoom: 110, yaw: Math.PI / 4 };
  private known = new Map<EntityId, Known>();
  private loops = new Map<EntityId, Loop>();
  private nextFlyby = new Map<EntityId, number>();
  private intensity = new Intensity();
  private voiceFreeAt = 0;
  private lastAlert = new Map<string, number>();
  private ambientIn = 4;
  private ended = false;
  private readonly team?: TeamId;
  private readonly units?: UnitAudioLookup;

  constructor(private readonly localPlayer: PlayerId, opts: AudioManagerOptions = {}) {
    this.team = opts.team;
    this.units = opts.units;
    // Everything is small (~3 MB decoded set); fetch it all up front so first shots aren't silent.
    this.eng.preload(filesOf(ALL_SOUNDS));
    this.music.set('calm');
  }

  /** Camera ground target, distance (zoom) and yaw. Call every frame before update(). */
  setListener(x: number, z: number, zoom: number, yaw = Math.PI / 4): void {
    const l = this.listener;
    l.x = x;
    l.z = z;
    l.zoom = zoom;
    l.yaw = yaw;
  }

  /** Same as setListener, derived from a three.js camera position and its ground look-at target. */
  setListenerFromCamera(camera: { x: number; y: number; z: number }, target: { x: number; y?: number; z: number }): void {
    const dx = camera.x - target.x;
    const dz = camera.z - target.z;
    this.setListener(target.x, target.z, Math.hypot(dx, camera.y - (target.y ?? 0), dz), Math.atan2(dx, dz));
  }

  /** Per-frame: engine/rotor loops, jet flybys, music intensity, ambient bed. */
  update(view: SimView, dt: number): void {
    this.refreshKnown(view);
    this.updateLoops(view);
    this.intensity.decay(dt);
    if (!this.ended && (this.music.state === 'calm' || this.music.state === 'battle')) {
      const next = nextCombatState(this.music.state, this.intensity.value, this.music.inState);
      if (next !== this.music.state) this.music.set(next);
    }
    this.updateAmbient(dt);
  }

  handleEvents(events: readonly SimEvent[], view?: SimView): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'fired': {
          const shooter = this.lookup(ev.id, view);
          const a = weaponAudio(ev.weapon, shooter?.type, this.units);
          const at = shooter ?? ev.at;
          if (!this.audible(view, at, ev.id)) break;
          this.play(a.fire, at);
          this.intensity.add(0.3 * this.proximity(at));
          break;
        }
        case 'hit': {
          const target = this.lookup(ev.id, view);
          if (!target || target.kind !== 'unit' || !this.audible(view, ev.at, ev.id)) break;
          // Bullets pinging off armour; explosive rounds already sound through `impact`.
          const shooter = ev.by !== undefined ? this.lookup(ev.by, view) : undefined;
          const bullet = !shooter || !weaponAudio('', shooter.type, this.units).impact;
          if (bullet && unitAudio(target.type, this.units).armored) this.play('hit_metal', ev.at);
          this.intensity.add(0.1);
          break;
        }
        case 'impact': {
          if (!this.audible(view, ev.at)) break;
          const a = weaponAudio(ev.weapon);
          if (a.impact) this.play(a.impact, ev.at);
          this.intensity.add(0.8 * this.proximity(ev.at));
          break;
        }
        case 'died': {
          const e = this.lookup(ev.id, view);
          if (!e || !this.audible(view, e)) {
            this.stopLoop(ev.id);
            break;
          }
          if (e.kind === 'unit') {
            const u = unitAudio(e.type, this.units);
            this.play(u.death, e);
            if (e.owner === this.localPlayer && u.death !== 'death_infantry') this.alert('lost', [voiceLine(u.voice, 'die')]);
          } else if (e.kind === 'structure') this.play('explosion_big', e);
          this.stopLoop(ev.id);
          this.intensity.add(2.5 * this.proximity(e));
          break;
        }
        case 'removed':
          this.stopLoop(ev.id);
          this.known.delete(ev.id);
          this.nextFlyby.delete(ev.id);
          break;
        case 'ordered':
          if (ev.player !== this.localPlayer) break;
          playFlat('ui_confirm', { gain: 0.6 });
          this.unitVoice(ev.units, 'action', view);
          break;
        case 'produced': {
          const u = this.lookup(ev.unit, view);
          if (u?.owner !== this.localPlayer) break;
          this.alert('produced', [voiceLine(unitAudio(u.type, this.units).voice, 'ready')]);
          break;
        }
        case 'demolish':
          // The building comes down: a dull collapse where it stood.
          if (ev.state === 'done' && this.audible(view, ev.at)) this.play('explosion_small', ev.at);
          else if (ev.state !== 'done' && this.lookup(ev.id, view)?.owner === this.localPlayer) playFlat('ui_confirm', { gain: 0.6 });
          break;
        case 'built': {
          const s = this.lookup(ev.id, view);
          if (s?.owner === this.localPlayer) playFlat('ui_confirm');
          break;
        }
        case 'captured':
          if (ev.by === this.localPlayer) this.alert('captured', ['radio_morse', 'ui_confirm']);
          else this.alert('captured', ['radio_morse'], 0.6);
          break;
        case 'underAttack':
          if (ev.player !== this.localPlayer) break;
          this.intensity.add(5);
          this.alert('underAttack', ['under_attack']);
          break;
        case 'defeated':
          if (ev.player !== this.localPlayer) break;
          this.endMatch(false);
          break;
        case 'victory': {
          const won = this.team !== undefined ? ev.team === this.team : !this.localDefeated(view);
          this.endMatch(won);
          break;
        }
        case 'incoming':
          // Shells on the way to our side: tension builds before they land.
          if (this.audible(view, ev.at)) this.intensity.add(1.5);
          break;
        case 'placed': {
          const s = this.lookup(ev.id, view);
          if (s?.owner === this.localPlayer) playFlat('ui_confirm', { gain: 0.7 });
          break;
        }
        case 'neutralized':
          if (ev.from === this.localPlayer) this.alert('captured', ['radio_morse']);
          break;
        case 'blocked':
          if (ev.player === this.localPlayer) playFlat('ui_error');
          break;
        case 'suddenDeath':
          this.intensity.add(BATTLE_ENTER);
          playFlat('siren', { gain: 0.7 });
          break;
        case 'abilityUsed': {
          const u = this.lookup(ev.id, view);
          if (u?.owner === this.localPlayer) this.unitVoice([ev.id], 'action', view);
          break;
        }
        case 'smoke':
          if (this.audible(view, ev.at)) this.play('smoke_pop', ev.at);
          break;
        case 'superweaponLaunched':
          // Everyone hears the warning; it's the point of the early warning.
          this.intensity.add(BATTLE_ENTER);
          playFlat('siren', { gain: 0.9 });
          this.play('missile', ev.at);
          break;
        case 'superweaponImpact':
          this.play('death_tank', ev.at);
          this.play('explosion_big', ev.at);
          this.intensity.add(6);
          break;
        case 'superweaponReady':
          if (ev.player === this.localPlayer) this.alert('produced', ['radio_morse', 'ui_confirm']);
          break;
        case 'promoted': {
          const u = this.lookup(ev.id, view);
          if (u?.owner === this.localPlayer) playFlat('ui_confirm', { gain: 0.8 });
          break;
        }
        case 'suppressed': {
          // Pinned own infantry: a radio burst so you notice without looking.
          const u = this.lookup(ev.id, view);
          if (ev.pinned && u?.owner === this.localPlayer) this.alert('underAttack', ['radio_static'], 0.6);
          break;
        }
        case 'boarded': {
          const u = this.lookup(ev.id, view);
          if (u?.owner === this.localPlayer && this.audible(view, u)) playFlat('ui_click', { gain: 0.5 });
          break;
        }
        case 'line':
          if (ev.owner === this.localPlayer) playFlat('radio_morse', { gain: 0.5 });
          break;
        case 'morale':
          // Morale breaking is a big moment either way: a radio burst, plus the siren if it's us.
          if (ev.low) this.alert('captured', ev.team === this.team ? ['siren', 'radio_static'] : ['radio_morse']);
          break;
        case 'paused':
          playFlat(ev.paused ? 'ui_open' : 'ui_close');
          break;
        default:
          // spawned, entrench, revealed, delivered: no sound.
          break;
      }
    }
  }

  /** Selection feedback; pass the selected ids to get a unit voice response. */
  uiSelect(ids?: readonly EntityId[], view?: SimView): void {
    playFlat('ui_select');
    if (ids?.length) this.unitVoice(ids, 'select', view);
  }

  ui(kind: UiSound): void {
    uiSound(kind);
  }

  /** Stop loops when the match is torn down. Music keeps going (the menu takes it over). */
  dispose(): void {
    for (const id of [...this.loops.keys()]) this.stopLoop(id);
    this.known.clear();
  }

  // -------------------------------------------------------------------------------------------

  private play(id: SoundId, at: Vec2, x?: PlayExtra): Voice | null {
    return playSound(id, this.listener, at, x);
  }

  /** 1 near the camera, falling to ~0.3 far away: combat you can see drives the music more. */
  private proximity(at: Vec2): number {
    return 0.3 + 0.7 * spatialize(this.listener, at.x, at.z, 300).gain;
  }

  /**
   * Whether the local player may hear something at `at` (or entity `id`): with fog of war, only
   * what they can see, so sound and music never give away hidden enemies.
   */
  private audible(view: SimView | undefined, at: Vec2, id?: EntityId): boolean {
    const fog = fogOf(view);
    if (!fog) return true;
    if (id !== undefined && fog.canSee(this.localPlayer, id)) return true;
    return fog.isVisible(this.localPlayer, at.x, at.z);
  }

  private lookup(id: EntityId, view?: SimView): Known | undefined {
    const e = view?.get(id);
    if (e) return this.remember(e);
    return this.known.get(id);
  }

  private remember(e: EntityState): Known {
    let k = this.known.get(e.id);
    if (!k) {
      k = { type: e.type, kind: e.kind, owner: e.owner, x: e.pos.x, z: e.pos.z };
      this.known.set(e.id, k);
    } else {
      k.owner = e.owner;
      k.x = e.pos.x;
      k.z = e.pos.z;
    }
    return k;
  }

  private refreshKnown(view: SimView): void {
    for (const e of view.entities()) if (e.kind === 'unit' || e.kind === 'structure') this.remember(e);
  }

  private localDefeated(view?: SimView): boolean {
    return !!view?.player(this.localPlayer)?.defeated;
  }

  private unitVoice(ids: readonly EntityId[], line: 'select' | 'action', view?: SimView): void {
    const now = this.eng.now;
    if (now < this.voiceFreeAt) return;
    const first = this.lookup(ids[0], view);
    if (!first) return;
    const id =
      first.kind === 'structure'
        ? line === 'select' ? structureSelectLine(first.type) : undefined
        : voiceLine(unitAudio(first.type, this.units).voice, line);
    if (!id) return;
    const v = playFlat(id);
    if (v) this.voiceFreeAt = now + VOICE_GAP;
  }

  /** Radio static burst, then the given lines; rate-limited per alert kind. */
  private alert(kind: string, lines: SoundId[], gain = 1): void {
    const now = this.eng.now;
    const last = this.lastAlert.get(kind);
    if (last !== undefined && now - last < (ALERT_GAP[kind] ?? 3)) return;
    this.lastAlert.set(kind, now);
    playFlat('radio_static', { gain });
    for (const l of lines) playFlat(l, { gain, delay: 0.15 });
    this.voiceFreeAt = Math.max(this.voiceFreeAt, now + 1.2);
    this.eng.duckMusic(0.35, 0.8, 1);
  }

  private endMatch(won: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.music.set(won ? 'victory' : 'defeat');
    playFlat('radio_static');
    if (won) playFlat('radio_morse', { delay: 0.2 });
    else playFlat('siren', { delay: 0.2 });
  }

  private updateLoops(view: SimView): void {
    if (!this.eng.running) return;
    const now = this.eng.now;
    // Score every vehicle with an engine by how loud it would be, keep the top MAX_LOOPS.
    const wanted: { e: EntityState; gain: number; pan: number; cutoff: number; rate: number; sound: SoundId }[] = [];
    const fog = fogOf(view);
    for (const e of view.entities()) {
      if (e.kind !== 'unit') continue;
      if (fog && !fog.canSee(this.localPlayer, e.id)) continue;
      const u = unitAudio(e.type, this.units);
      if (u.flyby) {
        this.flyby(e, now);
        continue;
      }
      const en = u.engine;
      if (!en) continue;
      const def: SoundDef = SOUNDS[en.sound];
      const s = spatialize(this.listener, e.pos.x, e.pos.z, def.range ?? 200);
      const gain = def.volume * en.volume * s.gain * (e.moving ? 1 : en.idle);
      if (gain < 0.008) continue;
      wanted.push({ e, gain, pan: s.pan, cutoff: s.cutoff, rate: en.rate * (e.moving ? 1 : 0.85), sound: en.sound });
    }
    wanted.sort((a, b) => b.gain - a.gain);
    const keep = new Set<EntityId>();
    for (const w of wanted.slice(0, MAX_LOOPS)) {
      keep.add(w.e.id);
      const loop = this.loops.get(w.e.id);
      if (loop && !loop.voice.ended) {
        loop.voice.set(w.gain, w.pan, w.cutoff, w.rate);
        continue;
      }
      const buf = this.eng.peek(pick(SOUNDS[w.sound].files));
      if (!buf) continue;
      const voice = this.eng.play(buf, {
        bus: 'sfx',
        gain: w.gain,
        pan: w.pan,
        cutoff: w.cutoff,
        rate: w.rate,
        loop: true,
        fadeIn: 0.5,
        // Random phase so a column of identical tanks doesn't phase-lock into one drone.
        offset: Math.random() * buf.duration * 0.8,
      });
      if (voice) this.loops.set(w.e.id, { voice, sound: w.sound });
    }
    for (const id of [...this.loops.keys()]) if (!keep.has(id)) this.stopLoop(id);
  }

  private flyby(e: EntityState, now: number): void {
    if (!e.moving) return;
    const next = this.nextFlyby.get(e.id);
    if (next !== undefined && now < next) return;
    if (this.play('jet_flyby', e.pos)) this.nextFlyby.set(e.id, now + 7 + Math.random() * 5);
    else if (next === undefined) this.nextFlyby.set(e.id, now + 1);
  }

  private stopLoop(id: EntityId): void {
    const l = this.loops.get(id);
    if (!l) return;
    l.voice.stop(0.6);
    this.loops.delete(id);
  }

  /** Distant gunfire bed: sparse at peace, denser and louder while fighting. */
  private updateAmbient(dt: number): void {
    this.ambientIn -= dt;
    if (this.ambientIn > 0 || this.ended) return;
    const heat = Math.min(1, this.intensity.value / 20);
    this.ambientIn = 9 - heat * 5 + Math.random() * 4;
    playFlat('battle_distant', { gain: 0.6 + heat * 0.8, pan: (Math.random() * 2 - 1) * 0.7 });
  }
}
