import { assetUrl } from '../shared/view';
import { BUSES, getAudioSettings, onAudioSettingsChange, type Bus } from './settings';

/** Options for one playing sound. */
export interface PlayOpts {
  bus: Exclude<Bus, 'master'>;
  gain: number;
  rate?: number;
  /** -1..1 stereo position. */
  pan?: number;
  /** Low-pass cutoff in Hz (distance muffling). Omit for none. */
  cutoff?: number;
  loop?: boolean;
  /** Start offset into the buffer, seconds. */
  offset?: number;
  /** Stop after this many seconds (one-shots only). */
  duration?: number;
  fadeIn?: number;
  delay?: number;
}

/** A playing sound. Loops stay alive until stop(). */
export interface Voice {
  readonly startedAt: number;
  readonly endsAt: number;
  gain: number;
  set(gain: number, pan?: number, cutoff?: number, rate?: number, ramp?: number): void;
  stop(fade?: number): void;
  readonly ended: boolean;
}

/** Hard ceiling on simultaneous one-shots so a 200-unit firefight can't overload the mixer. */
const MAX_VOICES = 48;

/**
 * Web Audio plumbing shared by the menu and every match: context, buses, buffer cache, voices.
 * One instance per page (see `audioEngine()`), because browsers limit AudioContexts.
 *
 *   source -> [lowpass] -> gain -> panner -> bus(sfx|voice|music) -> master -> destination
 *   music bus additionally passes a duck gain so explosions/voices can push it down.
 */
export class AudioEngine {
  ctx?: AudioContext;
  private master?: GainNode;
  private buses = new Map<Bus, GainNode>();
  private duck?: GainNode;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private decoded = new Map<string, AudioBuffer | null>();
  private voices = new Set<VoiceImpl>();
  private readyCbs: (() => void)[] = [];
  private runningCbs: (() => void)[] = [];

  constructor() {
    if (typeof window === 'undefined') return;
    const unlock = () => {
      this.init();
      void this.ctx?.resume();
      if (this.ctx?.state === 'running') {
        for (const e of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(e, unlock, true);
      }
    };
    for (const e of ['pointerdown', 'keydown', 'touchstart']) addEventListener(e, unlock, true);
    onAudioSettingsChange(() => this.applySettings());
  }

  /** Context exists and is running (a user gesture happened). */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Run `cb` once audio is unlocked (immediately if it already is). */
  whenReady(cb: () => void): void {
    if (this.ctx) cb();
    else this.readyCbs.push(cb);
  }

  /** Run `cb` once the context is actually running (unlocked and not suspended). */
  onceRunning(cb: () => void): void {
    if (this.running) cb();
    else this.runningCbs.push(cb);
  }

  private init(): void {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.onstatechange = () => {
      if (ctx.state !== 'running') return;
      const cbs = this.runningCbs;
      this.runningCbs = [];
      for (const cb of cbs) cb();
    };
    this.master = ctx.createGain();
    // A gentle limiter keeps stacked explosions from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);
    this.duck = ctx.createGain();
    this.duck.connect(this.master);
    for (const b of BUSES) {
      if (b === 'master') continue;
      const g = ctx.createGain();
      g.connect(b === 'music' ? this.duck : this.master);
      this.buses.set(b, g);
    }
    this.buses.set('master', this.master);
    this.applySettings(true);
    const cbs = this.readyCbs;
    this.readyCbs = [];
    for (const cb of cbs) cb();
  }

  private applySettings(instant = false): void {
    if (!this.ctx) return;
    const s = getAudioSettings();
    for (const b of BUSES) {
      const g = this.buses.get(b);
      if (!g) continue;
      const v = b === 'master' ? (s.muted ? 0 : s.volume.master) : s.volume[b];
      if (instant) g.gain.value = v;
      else g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }
  }

  /** Fetch + decode once; later calls share the promise. Resolves null on failure (logged once). */
  load(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      p = new Promise<AudioBuffer | null>((resolve) => this.whenReady(() => resolve(this.decode(path))));
      void p.then((b) => this.decoded.set(path, b));
      this.buffers.set(path, p);
    }
    return p;
  }

  private async decode(path: string): Promise<AudioBuffer | null> {
    try {
      const r = await fetch(assetUrl(path));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await this.ctx!.decodeAudioData(await r.arrayBuffer());
    } catch (e) {
      console.warn(`audio: could not load ${path}:`, e);
      return null;
    }
  }

  /** Decoded buffer, or undefined while loading (and starts loading it). Keeps the hot path sync. */
  peek(path: string): AudioBuffer | null | undefined {
    if (!this.decoded.has(path)) void this.load(path);
    return this.decoded.get(path);
  }

  preload(paths: Iterable<string>): void {
    for (const p of paths) void this.load(p);
  }

  /** Short dip of the music bus (big explosion, important voice line). */
  duckMusic(depth: number, hold = 0.3, release = 1.5): void {
    if (!this.ctx || !this.duck) return;
    const g = this.duck.gain;
    const t = this.ctx.currentTime;
    const target = Math.min(g.value, 1 - depth);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + 0.05);
    g.setValueAtTime(target, t + 0.05 + hold);
    g.linearRampToValueAtTime(1, t + 0.05 + hold + release);
  }

  activeVoices(): number {
    for (const v of this.voices) if (v.ended) this.voices.delete(v);
    return this.voices.size;
  }

  /** Start a decoded buffer. Returns null if audio is locked or the global voice cap is hit. */
  play(buf: AudioBuffer, o: PlayOpts): Voice | null {
    const ctx = this.ctx;
    const bus = this.buses.get(o.bus);
    if (!ctx || !bus || ctx.state !== 'running') return null;
    if (!o.loop && this.activeVoices() >= MAX_VOICES) {
      // Steal the quietest one-shot if the new sound is louder; otherwise drop the new one.
      let quietest: VoiceImpl | undefined;
      for (const v of this.voices) if (!v.loop && (!quietest || v.gain < quietest.gain)) quietest = v;
      if (!quietest || quietest.gain >= o.gain) return null;
      quietest.stop(0.05);
    }
    const v = new VoiceImpl(ctx, buf, o, bus);
    this.voices.add(v);
    return v;
  }
}

class VoiceImpl implements Voice {
  readonly startedAt: number;
  readonly endsAt: number;
  readonly loop: boolean;
  gain: number;
  ended = false;
  private src: AudioBufferSourceNode;
  private g: GainNode;
  private panner?: StereoPannerNode;
  private filter?: BiquadFilterNode;

  constructor(private readonly ctx: AudioContext, buf: AudioBuffer, o: PlayOpts, out: AudioNode) {
    const t = ctx.currentTime + (o.delay ?? 0);
    this.loop = !!o.loop;
    this.gain = o.gain;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 1;
    if (o.loop) {
      src.loop = true;
      // Skip MP3 encoder padding at both ends so the loop doesn't click.
      src.loopStart = Math.min(0.05, buf.duration * 0.05);
      src.loopEnd = Math.max(src.loopStart + 0.01, buf.duration - 0.05);
    }
    this.src = src;
    let node: AudioNode = src;
    if (o.cutoff !== undefined) {
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = o.cutoff;
      node = node.connect(this.filter);
    }
    this.g = ctx.createGain();
    const fadeIn = o.fadeIn ?? 0;
    if (fadeIn > 0) {
      this.g.gain.setValueAtTime(0, t);
      this.g.gain.linearRampToValueAtTime(o.gain, t + fadeIn);
    } else this.g.gain.value = o.gain;
    node = node.connect(this.g);
    if (o.pan !== undefined) {
      this.panner = ctx.createStereoPanner();
      this.panner.pan.value = o.pan;
      node = node.connect(this.panner);
    }
    node.connect(out);
    const offset = o.offset ?? (o.loop ? src.loopStart : 0);
    if (o.duration !== undefined && !o.loop) {
      src.start(t, offset, o.duration + 0.05);
      this.g.gain.setValueAtTime(o.gain, t + Math.max(0, o.duration - 0.05));
      this.g.gain.linearRampToValueAtTime(0, t + o.duration + 0.05);
    } else src.start(t, offset);
    this.startedAt = t;
    const len = o.duration ?? (buf.duration - offset) / (o.rate ?? 1);
    this.endsAt = o.loop ? Infinity : t + len;
    src.onended = () => {
      this.ended = true;
      src.disconnect();
      this.g.disconnect();
      this.panner?.disconnect();
      this.filter?.disconnect();
    };
  }

  set(gain: number, pan?: number, cutoff?: number, rate?: number, ramp = 0.08): void {
    if (this.ended) return;
    const t = this.ctx.currentTime;
    this.gain = gain;
    this.g.gain.setTargetAtTime(gain, t, ramp);
    if (pan !== undefined && this.panner) this.panner.pan.setTargetAtTime(pan, t, ramp);
    if (cutoff !== undefined && this.filter) this.filter.frequency.setTargetAtTime(cutoff, t, ramp);
    if (rate !== undefined) this.src.playbackRate.setTargetAtTime(rate, t, ramp * 2);
  }

  stop(fade = 0.1): void {
    if (this.ended) return;
    const t = this.ctx.currentTime;
    const g = this.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    try {
      this.src.stop(t + fade + 0.02);
    } catch {
      // Already stopped.
    }
    this.gain = 0;
  }
}

let shared: AudioEngine | undefined;

/** The page-wide engine. Created lazily; the AudioContext itself waits for a user gesture. */
export function audioEngine(): AudioEngine {
  return (shared ??= new AudioEngine());
}
