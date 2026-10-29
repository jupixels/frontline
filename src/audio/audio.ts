import type { SimEvent } from '../shared/events';
import type { PlayerId } from '../shared/types';
import { assetUrl } from '../shared/view';

/** Minimal Phase 0 audio: UI acknowledgements + menu music. The audio workstream expands this. */
export class AudioManager {
  private ctx?: AudioContext;
  private master?: GainNode;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();

  constructor(private readonly localPlayer: PlayerId) {
    // Browsers only allow audio after a user gesture.
    const unlock = () => {
      this.init();
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
  }

  private init(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
    this.playLoop('sounds/music/war_lament_01.mp3', 0.18);
  }

  private load(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p && this.ctx) {
      const ctx = this.ctx;
      p = fetch(assetUrl(path))
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(path, p);
    }
    return p ?? Promise.resolve(null);
  }

  async play(path: string, volume = 1, loop = false): Promise<void> {
    const buf = await this.load(path);
    if (!buf || !this.ctx || !this.master) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = loop ? 1 : 0.95 + Math.random() * 0.1;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master);
    src.start();
  }

  playLoop(path: string, volume: number): void {
    void this.play(path, volume, true);
  }

  handleEvents(events: SimEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'ordered' && ev.player === this.localPlayer) {
        void this.play(`sounds/ui/confirm_0${1 + Math.floor(Math.random() * 4)}.mp3`, 0.5);
      }
    }
  }

  uiSelect(): void {
    void this.play('sounds/ui/select_01.mp3', 0.35);
  }
}
