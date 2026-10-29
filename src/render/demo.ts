import type { SimView } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { GameRenderer } from './renderer';

/**
 * Debug-only firefight for checking VFX before the sim has combat: units of different owners near
 * the camera "shoot" each other with synthetic `fired`/`impact`/`hit` events. Purely visual; it feeds
 * events to the renderer and never touches the sim. From the console:
 *   const stop = frontlineRenderDemo(match.renderer, match.sim)
 */
export function startRenderDemo(renderer: GameRenderer, sim: SimView, radius = 140): () => void {
  let timer = 0;
  const id = setInterval(() => {
    timer++;
    const near = [...sim.entities()].filter((e) => Math.hypot(e.pos.x - renderer.cam.target.x, e.pos.z - renderer.cam.target.z) < radius);
    if (near.length < 2) return;
    const events: SimEvent[] = [];
    for (let k = 0; k < 3; k++) {
      const a = near[Math.floor(Math.random() * near.length)];
      const enemies = near.filter((e) => e.owner !== a.owner);
      const b = enemies.length ? enemies[Math.floor(Math.random() * enemies.length)] : undefined;
      const at = b ? { x: b.pos.x + (Math.random() - 0.5) * 6, z: b.pos.z + (Math.random() - 0.5) * 6 } : { x: a.pos.x + Math.sin(a.heading) * 60, z: a.pos.z + Math.cos(a.heading) * 60 };
      const weapon = a.type === 'rifleman' ? (Math.random() < 0.15 ? 'rpg' : 'rifle') : a.type === 'tank_mbt' ? 'cannon' : a.type === 'ifv' ? (Math.random() < 0.3 ? 'atgm' : 'autocannon') : 'mg';
      events.push({ type: 'fired', id: a.id, weapon, target: b?.id, at });
      if (weapon !== 'rifle' && weapon !== 'mg') events.push({ type: 'impact', weapon, at });
      if (b) events.push({ type: 'hit', id: b.id, by: a.id, damage: 10, at });
    }
    // Occasional artillery to show the big blasts.
    if (timer % 9 === 0) {
      const t = renderer.cam.target;
      events.push({ type: 'impact', weapon: 'artillery', at: { x: t.x + (Math.random() - 0.5) * 80, z: t.z + (Math.random() - 0.5) * 80 } });
    }
    renderer.handleEvents(sim, events);
  }, 350);
  return () => clearInterval(id);
}

Object.assign(globalThis, { frontlineRenderDemo: startRenderDemo });
