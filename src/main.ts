import { setMuted, setVolume } from './audio/audio';
import { MAPS } from './game/content';
import { Match } from './game/match';
import { NetLobbyAdapter, netLobbyConnector } from './game/netLobby';
import { Tutorial } from './game/tutorial';
import { downloadReplay, ReplaySession, type ReplayFile } from './net/replay';
import { LocalSession } from './net/session';
import type { MatchSetup, PlayerId, Tick } from './shared/types';
import { UiApp, type MatchMode, type ReplayControls, type StartInfo } from './ui';

// Menu → lobby (P2P room or skirmish) → match → results, plus tutorial and replays.
// `?fakeLobby` uses scripted peers for UI work.
const fakeLobby = new URLSearchParams(location.search).has('fakeLobby');

let match: Match | null = null;
let tutorial: Tutorial | null = null;
/** The match that last ended, for "save / watch replay" on the results screen. */
let finished: Match | null = null;
/** Replay being watched: its file, perspective and transport state survive match rebuilds (seek). */
let watching: { replay: ReplayFile; viewAs: PlayerId; speed: number; paused: boolean } | null = null;

/** A fresh canvas per match: the old WebGL context is dropped when a match ends. */
function freshCanvas(): HTMLCanvasElement {
  const old = document.getElementById('game') as HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  old.replaceWith(canvas);
  return canvas;
}

const replayControls: ReplayControls = {
  state: () => ({
    tick: match?.sim.tick ?? 0,
    end: watching?.replay.endTick ?? 0,
    paused: match?.isPaused ?? true,
    speed: match?.speed ?? 1,
    ended: match?.ended ?? false,
    viewAs: watching?.viewAs ?? 0,
  }),
  setPaused: (p) => {
    if (watching) watching.paused = p;
    match?.setPaused(p);
  },
  setSpeed: (s) => {
    if (watching) watching.speed = s;
    if (match) match.speed = s;
  },
  seek: (tick) => {
    if (!match || !watching) return;
    if (tick >= match.sim.tick) match.runTo(tick);
    else rebuildReplay(tick);
  },
  viewAs: (player) => {
    if (!match || !watching) return;
    watching.viewAs = player;
    rebuildReplay(match.sim.tick);
  },
};

/** Restart the replay match (new perspective or a rewind) and fast-forward to `tick`. */
function rebuildReplay(tick: Tick): void {
  if (!watching) return;
  match?.stop();
  match = null;
  startMatch(watching.replay.setup, 'replay', { replay: watching.replay, localPlayer: watching.viewAs }, tick);
}

function startMatch(setup: MatchSetup, mode: MatchMode, info: StartInfo, seekTo = 0): void {
  match?.stop();
  tutorial?.dispose();
  tutorial = null;
  const adapter = info.lobby instanceof NetLobbyAdapter ? info.lobby : null;
  if (info.replay) {
    if (watching?.replay !== info.replay) watching = { replay: info.replay, viewAs: info.localPlayer, speed: 1, paused: false };
  } else watching = null;
  const net = info.replay ? new ReplaySession(info.replay, info.localPlayer) : (adapter?.match?.session ?? new LocalSession(info.localPlayer));
  try {
    match = new Match({ setup, mode, net, localPlayer: info.localPlayer, app, canvas: freshCanvas(), replay: info.replay, replayControls: info.replay ? replayControls : undefined });
    const q = new URLSearchParams(location.search);
    match.speed = watching ? watching.speed : Math.max(1, Math.min(16, Number(q.get('speed')) || 1));
    const auto = q.get('autoplay');
    if (auto === 'easy' || auto === 'normal' || auto === 'hard') match.setAutoplay(auto);
    if (seekTo > 0) match.runTo(seekTo);
    if (watching?.paused) match.setPaused(true);
    if (mode === 'tutorial') tutorial = new Tutorial(match, app);
    match.start();
  } catch (err) {
    console.error(err);
    app.toast(`Couldn't start the match: ${(err as Error).message}`, 'error');
    app.leaveMatch();
  }
}

const app = new UiApp({
  root: document.getElementById('ui')!,
  maps: MAPS,
  lobby: fakeLobby ? undefined : netLobbyConnector,
  onStartMatch: (setup, mode, info) => startMatch(setup, mode, info),
  onLeaveMatch: () => {
    if (match && match.ui && !watching) finished = match;
    match?.stop();
    match = null;
    tutorial?.dispose();
    tutorial = null;
    watching = null;
  },
  lastReplay: () => {
    const m = match ?? finished;
    if (!m || watching) return null;
    const log = m.commandLog();
    return { format: 'frontline-replay', version: 1, savedAt: new Date().toISOString(), ...log };
  },
  downloadReplay: (r) => downloadReplay(r),
  onSettingsChange: (s) => {
    for (const bus of ['master', 'music', 'sfx', 'voice'] as const) setVolume(bus, s.volume[bus]);
    document.documentElement.dataset.quality = s.graphics;
    match?.renderer.setQuality(s.graphics);
  },
});
app.start();

// Dev shortcut: ?quick=<mapId>&ai=normal,hard&teams=0,1,0 starts a skirmish straight away.
const params = new URLSearchParams(location.search);
const quick = params.get('quick');
if (quick) {
  const ais = (params.get('ai') ?? 'normal').split(',').filter(Boolean) as ('easy' | 'normal' | 'hard')[];
  const teams = params.get('teams')?.split(',').map(Number);
  app.quickSkirmish(quick, ais, teams);
} else if (params.has('tutorial')) app.tutorial();
if (params.has('mute')) setMuted(true);

// Handy for debugging in the console.
Object.defineProperty(window, 'match', { get: () => match });
Object.defineProperty(window, 'tutorial', { get: () => tutorial });
Object.assign(window, { app });
