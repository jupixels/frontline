import { setMuted, setVolume } from './audio/audio';
import { MAPS } from './game/content';
import { Match } from './game/match';
import { NetLobbyAdapter, netLobbyConnector } from './game/netLobby';
import { LocalSession } from './net/session';
import { UiApp } from './ui';

// Menu → lobby (P2P room or skirmish) → match → results. `?fakeLobby` uses scripted peers for UI work.
const fakeLobby = new URLSearchParams(location.search).has('fakeLobby');

let match: Match | null = null;

/** A fresh canvas per match: the old WebGL context is dropped when a match ends. */
function freshCanvas(): HTMLCanvasElement {
  const old = document.getElementById('game') as HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  old.replaceWith(canvas);
  return canvas;
}

const app = new UiApp({
  root: document.getElementById('ui')!,
  maps: MAPS,
  lobby: fakeLobby ? undefined : netLobbyConnector,
  onStartMatch: (setup, mode, info) => {
    match?.stop();
    const adapter = info.lobby instanceof NetLobbyAdapter ? info.lobby : null;
    const net = adapter?.match?.session ?? new LocalSession(info.localPlayer);
    try {
      match = new Match({ setup, mode, net, localPlayer: info.localPlayer, app, canvas: freshCanvas() });
      const q = new URLSearchParams(location.search);
      match.speed = Math.max(1, Math.min(16, Number(q.get('speed')) || 1));
      const auto = q.get('autoplay');
      if (auto === 'easy' || auto === 'normal' || auto === 'hard') match.setAutoplay(auto);
      match.start();
    } catch (err) {
      console.error(err);
      app.toast(`Couldn't start the match: ${(err as Error).message}`, 'error');
      app.leaveMatch();
    }
  },
  onLeaveMatch: () => {
    match?.stop();
    match = null;
  },
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
}
if (params.has('mute')) setMuted(true);

// Handy for debugging in the console.
Object.defineProperty(window, 'match', { get: () => match });
Object.assign(window, { app });
