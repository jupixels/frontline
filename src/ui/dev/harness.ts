// Dev-only UI harness: wires UiApp to sim + render + a local session exactly the way the master
// session is expected to in src/main.ts / src/game/match.ts. Not part of the production build.
import units from '../../../data/units.json';
import sandbox from '../../../data/maps/sandbox.json';
import { LocalSession } from '../../net/session';
import { GameRenderer } from '../../render/renderer';
import type { MapDef, UnitDef } from '../../shared/data';
import type { SimEvent } from '../../shared/events';
import { TICK_MS, type MatchSetup } from '../../shared/types';
import { Simulation } from '../../sim/simulation';
import { UiApp, mapInfoFromDef, type MapInfo, type MatchMode, type MatchUi, type StartInfo } from '../index';

const unitDefs = units as Record<string, UnitDef>;

// Sandbox is the only real map so far; the others are flat stand-ins with the planned spawn counts
// so the lobby's map picker has something to show.
const MAPS: MapInfo[] = [
  mapInfoFromDef(sandbox as MapDef, 'Flat proving ground. Four corner spawns, no cover.'),
  { id: 'valley_pass', name: 'Valley Pass', maxPlayers: 2, size: 2000, description: 'River valley with three bridges. Land only. (stand-in)', spawns: [{ x: -700, z: 650 }, { x: 700, z: -650 }] },
  {
    id: 'coastal_strait',
    name: 'Coastal Strait',
    maxPlayers: 4,
    size: 2400,
    description: 'Islands and mainland; naval control decides it. (stand-in)',
    spawns: [{ x: -900, z: 800 }, { x: 900, z: -800 }, { x: -900, z: -800 }, { x: 900, z: 800 }],
  },
  {
    id: 'desert_oilfields',
    name: 'Desert Oilfields',
    maxPlayers: 8,
    size: 2600,
    description: 'Open terrain, many supply nodes, armor country. (stand-in)',
    spawns: [-1, 1].flatMap((sx) => [-900, -300, 300, 900].map((z) => ({ x: sx * 1000, z }))),
  },
];

function mapDefFor(id: string): MapDef {
  if (id === sandbox.id) return sandbox as MapDef;
  const m = MAPS.find((x) => x.id === id) ?? MAPS[0];
  return { id: m.id, name: m.name, size: m.size, spawns: m.spawns };
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const root = document.getElementById('ui')!;

interface Running {
  sim: Simulation;
  renderer: GameRenderer;
  net: LocalSession;
  ui: MatchUi;
  paused: boolean;
  stop(): void;
}
let running: Running | null = null;
let renderer: GameRenderer | null = null;

const app = new UiApp({
  root,
  maps: MAPS,
  onStartMatch: (setup, mode, info) => void startMatch(setup, mode, info),
  onLeaveMatch: () => {
    running?.stop();
    running = null;
  },
  onSettingsChange: (s) => {
    // TODO(render/audio): apply s.graphics and s.volume once those modules expose setters.
    document.documentElement.dataset.quality = s.graphics;
  },
});

async function startMatch(setup: MatchSetup, mode: MatchMode, info: StartInfo): Promise<void> {
  const step = (f: number, label: string) => new Promise<void>((r) => {
    app.setLoadingProgress(f, label);
    setTimeout(r, 180);
  });
  await step(0.15, 'Reading map');
  const map = mapDefFor(setup.mapId);
  const sim = new Simulation(setup, { units: unitDefs, map });
  await step(0.4, 'Building terrain');
  // One renderer per page: GameRenderer has no dispose yet (TODO(render)).
  renderer ??= new GameRenderer({ canvas, mapSize: map.size, units: unitDefs, players: setup.players });
  const r = renderer;
  await step(0.75, 'Loading units');
  const local = Math.max(0, info.localPlayer);
  const net = new LocalSession(local);
  const spawn = map.spawns[local % map.spawns.length];
  r.cam.setBounds(map.size / 2);
  r.cam.lookAt(spawn.x, spawn.z);
  for (const e of sim.entities()) r.handleEvents(sim, [{ type: 'spawned', id: e.id }]);
  await step(0.95, 'Synchronizing');

  const ui = app.createMatchUi({
    canvas,
    sim,
    picker: r,
    camera: { lookAt: (x, z) => r.cam.lookAt(x, z), get target() { return r.cam.target; } },
    setup,
    localPlayer: local,
    units: unitDefs,
    map,
    mode,
    issue: (cmd) => net.submit(cmd),
    onSelectionChange: (ids) => r.setSelection(ids),
    onPauseChange: (p) => {
      if (running) running.paused = p;
    },
  });

  let alive = true;
  let acc = 0;
  let last = performance.now();
  const run: Running = {
    sim,
    renderer: r,
    net,
    ui,
    paused: false,
    stop: () => {
      alive = false;
      for (const e of sim.entities()) r.handleEvents(sim, [{ type: 'removed', id: e.id }]);
    },
  };
  running = run;

  // Toy opponent: every 25 s the AI players attack-move toward their nearest enemy spawn.
  let aiTimer = 0;
  const loop = (now: number) => {
    if (!alive) return;
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (!run.paused) {
      acc += dt * 1000;
      aiTimer += dt;
      if (aiTimer > 25) {
        aiTimer = 0;
        for (const p of setup.players) {
          if (p.kind !== 'ai') continue;
          const foe = setup.players.find((q) => q.team !== p.team);
          if (!foe) continue;
          const ids = [...sim.entities()].filter((e) => e.owner === p.id).map((e) => e.id);
          const target = map.spawns[foe.id % map.spawns.length];
          net.submit({ type: 'move', units: ids, target: { x: target.x * 0.6, z: target.z * 0.6 }, attackMove: true }, p.id);
        }
      }
      let steps = 0;
      while (acc >= TICK_MS && steps < 10) {
        r.beforeStep(sim);
        const events = sim.step(net.pollTurn(sim.tick).commands);
        r.handleEvents(sim, events);
        ui.handleEvents(events);
        acc -= TICK_MS;
        steps++;
      }
      if (steps === 10) acc = 0;
    } else acc = 0;
    r.frame(sim, Math.min(acc / TICK_MS, 1), dt);
    ui.frame(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  if (new URLSearchParams(location.search).has('demo')) demoEvents(run, local);
}

/** `?demo`: synthetic events so alerts, pings and overlays can be seen before the sim emits them. */
function demoEvents(run: Running, local: number): void {
  const mine = [...run.sim.entities()].filter((e) => e.owner === local);
  const foe = [...run.sim.entities()].find((e) => e.owner !== local);
  const ev = (events: SimEvent[]) => run.ui.handleEvents(events);
  setTimeout(() => mine[0] && foe && ev([{ type: 'hit', id: mine[0].id, by: foe.id, damage: 40, at: mine[0].pos }]), 2500);
  setTimeout(() => foe && ev([{ type: 'underAttack', player: local, at: { x: foe.pos.x * 0.3, z: foe.pos.z * 0.3 } }]), 4500);
}

app.start();
Object.assign(window, { app });
Object.defineProperty(window, 'match', { get: () => running });
