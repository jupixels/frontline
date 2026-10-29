import type { SimView } from '../shared/entities';
import type { PlayerId } from '../shared/types';

/** Minimal Phase 0 HUD: top bar + controls help. The UI workstream replaces this. */
export class Hud {
  private readonly stats: HTMLSpanElement;
  private readonly sel: HTMLSpanElement;
  private fps = 60;

  constructor(root: HTMLElement) {
    const top = document.createElement('div');
    top.className = 'hud-top';
    top.innerHTML = `<span class="brand">FRONTLINE</span><span class="sel"></span><span class="dim stats"></span>`;
    this.sel = top.querySelector('.sel')!;
    this.stats = top.querySelector('.stats')!;

    const help = document.createElement('div');
    help.className = 'hud-help';
    help.innerHTML = [
      '<b>Left drag</b> select · <b>Right click</b> move / attack',
      '<b>A</b> attack-move · <b>S</b> stop · <b>H</b> hold · <b>Ctrl+1-9</b> group',
      '<b>Arrows / screen edge</b> pan · <b>Wheel</b> zoom · <b>Middle drag</b> rotate',
    ].join('<br>');
    root.append(top, help);
  }

  update(sim: SimView, _player: PlayerId, selected: number, dt: number): void {
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    this.sel.textContent = selected ? `${selected} selected` : 'no selection';
    this.stats.textContent = `T ${sim.tick} · ${this.fps.toFixed(0)} fps`;
  }
}
