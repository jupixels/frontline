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
    // TODO(audio): apply s.volume once the audio PR lands.
    document.documentElement.dataset.quality = s.graphics;
    match?.renderer.setQuality(s.graphics);
  },
});
app.start();

// Handy for debugging in the console.
Object.defineProperty(window, 'match', { get: () => match });
Object.assign(window, { app });
