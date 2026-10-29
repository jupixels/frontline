// Dev-only page (served by `npm run dev` at /src/net/harness.html, not part of the build).
// Connects two or more tabs through the real Trystero relays and runs a headless sim over
// the lockstep session, so turn exchange, RTT, stalls and hashes can be watched live.
import units from '../../data/units.json';
import sandbox from '../../data/maps/sandbox.json';
import type { MapDef, UnitDef } from '../shared/data';
import { TICK_MS } from '../shared/types';
import { Simulation } from '../sim/simulation';
import { hostLobby, joinLobby, roomCodeFromUrl, type Lobby, type StartedMatch } from './lobby';
import { downloadReplay } from './replay';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (text: string, err = false) => {
  const line = `${new Date().toLocaleTimeString()} ${text}\n`;
  $('log').insertAdjacentHTML('afterbegin', err ? `<span class="err">${line}</span>` : line);
};
const setStatus = (s: string) => ($('status').textContent = s);

let lobby: Lobby | null = null;
($('name') as HTMLInputElement).value = `tab-${Math.floor(Math.random() * 1000)}`;
const fromUrl = roomCodeFromUrl();
if (fromUrl) ($('code') as HTMLInputElement).value = fromUrl;

function bind(l: Lobby): void {
  lobby = l;
  Object.assign(window, { lobby: l });
  history.replaceState(null, '', `#room=${l.code}`);
  setStatus(`room ${l.code} — ${l.isHost ? 'host' : 'client'} — share ${l.url}`);
  const render = () => {
    const s = l.snapshot;
    $('lobby').textContent =
      `phase=${s.phase} host=${s.hostPeer.slice(0, 6)} me=${l.selfId.slice(0, 6)} peers=${l.peerCount}\n` +
      `settings=${JSON.stringify(s.settings)}\n` +
      l.slots.map((x) => `#${x.index} ${x.state.padEnd(6)} ${x.name.padEnd(16)} team=${x.team} ${x.color} ready=${x.ready}`).join('\n') +
      `\nrelays: ${l.transportStatus.strategies.map((x) => `${x.name} ${x.relaysOpen}/${x.relaysTotal}`).join(', ')}`;
  };
  l.on('change', render);
  l.on('chat', (m) => log(`[chat] ${m.name || '*'}: ${m.text}`));
  l.on('hostChanged', (h) => log(`host changed (me: ${h.isSelf})`));
  l.on('closed', (e) => {
    log(`closed: ${e.code} ${e.message}`, e.code !== 'closed');
    setStatus('closed');
  });
  l.on('start', run);
  render();
  if (l.match) run(l.match);
}

function run({ setup, session, rejoined }: StartedMatch): void {
  log(`match started seed=${setup.seed} players=${setup.players.map((p) => p.name).join(',')} rejoined=${rejoined}`);
  const sim = new Simulation(setup, { units: units as Record<string, UnitDef>, map: sandbox as MapDef });
  session.events.on('desync', (d) => log(`DESYNC at ${d.tick}: ${JSON.stringify(d.hashes)}`, true));
  session.events.on('playerLeft', (e) => log(`player ${e.player} left at tick ${e.tick}`));
  session.events.on('playerRejoined', (e) => log(`player ${e.player} rejoins at tick ${e.tick}`));
  session.events.on('control', (e) => log(`now controlling ${e.players.join(',')}`));
  session.events.on('dropped', () => log('we were dropped; reload to rejoin', true));
  Object.assign(window, { session, sim, saveReplay: () => downloadReplay(session.commandLog()) });

  let acc = 0;
  let last = performance.now();
  let lastHash = 0;
  let turnsWithCommands = 0;
  // A timer instead of requestAnimationFrame: rAF stops in background tabs, which would stall
  // every peer. Hidden tabs get throttled timers (~1 Hz), so allow a bigger catch-up there.
  const loop = () => {
    const now = performance.now();
    acc += Math.min(now - last, 2000);
    last = now;
    const ff = session.backlogTicks(sim.tick) > 20;
    let steps = 0;
    const cap = document.hidden ? 40 : 10;
    while (ff ? steps < 2000 : acc >= TICK_MS && steps < cap) {
      const turn = session.pollTurn(sim.tick);
      if (!turn) {
        acc = Math.min(acc, TICK_MS);
        break;
      }
      if (turn.commands.length) turnsWithCommands++;
      sim.step(turn.commands);
      if (sim.tick % 50 === 0) session.reportHash(sim.tick, (lastHash = sim.hash()));
      if (!ff) acc -= TICK_MS;
      steps++;
      // Random orders twice a second so turns carry real commands.
      if (sim.tick % 10 === 0 && Math.random() < 0.5) {
        const mine = [...sim.entities()].filter((e) => e.owner === session.localPlayer).map((e) => e.id);
        session.submit({ type: 'move', units: mine, target: { x: Math.random() * 300 - 150, z: Math.random() * 300 - 150 } });
      }
    }
    const st = session.status;
    $('match').textContent =
      `tick=${sim.tick} phase=${st.phase} waitingFor=[${st.waitingFor}] delay=${st.inputDelayTicks} ticks\n` +
      `rtt=${JSON.stringify(st.rtt)} authority=${st.authority} me=${session.localPlayer} controls=[${session.controlledPlayers()}]\n` +
      `turnsWithCommands=${turnsWithCommands} lastHash=${lastHash.toString(16)}`;
  };
  setInterval(loop, 16);
}

async function attempt(fn: () => Promise<Lobby>): Promise<void> {
  if (lobby) return;
  setStatus('connecting…');
  try {
    bind(await fn());
  } catch (e) {
    log(String(e), true);
    setStatus('failed');
  }
}

const name = () => ($('name') as HTMLInputElement).value;
$('host').onclick = () => attempt(() => hostLobby({ name: name() }));
$('join').onclick = () => attempt(() => joinLobby(($('code') as HTMLInputElement).value, { name: name() }));
$('ready').onclick = () => lobby?.setReady(!lobby.localSlot?.ready);
$('ai').onclick = () => lobby?.addAi('normal');
$('start').onclick = () => {
  const check = lobby?.canStart();
  if (check?.ok) void lobby!.start();
  else log(`can't start: ${check?.reason}`, true);
};
$('leave').onclick = () => {
  lobby?.leave();
  lobby = null;
};
$('send').onclick = () => {
  lobby?.sendChat(($('chat') as HTMLInputElement).value);
  ($('chat') as HTMLInputElement).value = '';
};
