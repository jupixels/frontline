import type { ReplayFile } from '../net/replay';
import type { MatchSetup, PlayerId } from '../shared/types';
import type { AiDifficulty } from './lobbyApi';
import { h } from './dom';
import { MatchUi, type MatchUiContext } from './hud/matchUi';
import {
  FakeLobbyConnector,
  createSkirmishLobby,
  roomCodeFromHash,
  selfPlayerId,
  type LobbyApi,
  type LobbyConnector,
  type MapInfo,
  type MatchMode,
} from './lobbyApi';
import { Backdrop } from './screens/backdrop';
import { CreditsScreen } from './screens/credits';
import { LoadingScreen } from './screens/loading';
import { LobbyScreen } from './screens/lobby';
import { MenuScreen } from './screens/menu';
import { ResultsScreen, type MatchResult } from './screens/results';
import type { Screen } from './screens/screen';
import { RecordScreen } from './screens/record';
import { ReplaysScreen } from './screens/replays';
import { SettingsScreen } from './screens/settings';
import { SettingsStore, type Settings } from './settings';
import { loadRecord, recordMatch, saveRecord } from './records';
import { storeReplay } from './replayStore';
import { tooltip } from './tooltip';

export interface StartInfo {
  /** The room or skirmish lobby (absent when watching a replay). */
  lobby?: LobbyApi;
  /** Set when watching a replay: play this log instead of live input. */
  replay?: ReplayFile;
  /** This client's PlayerId in `setup.players`. */
  localPlayer: PlayerId;
}

export interface UiAppOptions {
  /** The #ui overlay element. */
  root: HTMLElement;
  /** Maps offered in lobbies. The first one is the default. */
  maps: MapInfo[];
  /** Real P2P rooms. Defaults to FakeLobbyConnector (scripted peers) for standalone UI work. */
  lobby?: LobbyConnector;
  settings?: SettingsStore;
  /**
   * The host started (or a skirmish deployed). The loading screen is up: build the match, report
   * progress with `setLoadingProgress`, then call `createMatchUi`.
   */
  onStartMatch(setup: MatchSetup, mode: MatchMode, info: StartInfo): void;
  /** The player left the match (quit, desync, or results dismissed). Dispose the match here. */
  onLeaveMatch?(): void;
  /** Settings changed (graphics preset, volumes, ...). Also called once at startup. */
  onSettingsChange?(s: Settings): void;
  /** The command log of the match that just ended (for "save" / "watch replay"), if any. */
  lastReplay?(): ReplayFile | null;
  /** Offer a replay as a file download. */
  downloadReplay?(r: ReplayFile): void;
}

/** Settings that style the whole page: UI scale, reduced motion, tooltips. */
export function applyGlobalSettings(s: Settings): void {
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(s.uiScale));
  const reduce = s.motion === 'reduced' || (s.motion === 'system' && matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  root.dataset.motion = reduce ? 'reduced' : 'full';
  tooltip.enabled = s.tooltips;
}

/**
 * The UI application: menus → lobby → loading → in-match HUD → results. `src/main.ts` creates one
 * and wires its callbacks to the match runner.
 */
export class UiApp {
  readonly settings: SettingsStore;
  private readonly screensEl: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly backdrop = new Backdrop();
  private screen: Screen | null = null;
  private modal: Screen | null = null;
  private lobby: LobbyApi | null = null;
  private lobbyMode: MatchMode = 'skirmish';
  private loading: LoadingScreen | null = null;
  private matchUi: MatchUi | null = null;
  private readonly connector: LobbyConnector;

  constructor(private readonly opts: UiAppOptions) {
    this.settings = opts.settings ?? new SettingsStore();
    this.connector = opts.lobby ?? new FakeLobbyConnector(opts.maps, { peers: 1 });
    this.screensEl = h('div', { class: 'screens' });
    this.toasts = h('div', { class: 'toast-stack' });
    opts.root.append(this.screensEl, this.toasts);
    this.screensEl.appendChild(this.backdrop.el);

    addEventListener('keydown', (e) => this.onKey(e), true);
    addEventListener('hashchange', () => {
      const code = roomCodeFromHash(location.hash);
      if (code && !this.lobby && !this.matchUi) void this.join(code);
    });
    this.settings.subscribe((s) => {
      applyGlobalSettings(s);
      opts.onSettingsChange?.(s);
    });
    applyGlobalSettings(this.settings.get());
    opts.onSettingsChange?.(this.settings.get());
  }

  /** Show the title screen, or join straight away when the URL has #room=CODE. */
  start(): void {
    const code = roomCodeFromHash(location.hash);
    this.showMenu(code ?? '');
    if (code) void this.join(code);
  }

  // --- screen management

  private show(s: Screen, backdrop = true): void {
    this.closeModal();
    this.screen?.dispose?.();
    this.screen?.el.remove();
    this.screen = s;
    this.screensEl.appendChild(s.el);
    this.backdrop.el.classList.toggle('hidden', !backdrop);
    this.screensEl.classList.remove('hidden');
    document.body.classList.add('in-menu');
    document.body.classList.remove('in-match');
  }

  private hideScreens(): void {
    this.closeModal();
    this.screen?.dispose?.();
    this.screen?.el.remove();
    this.screen = null;
    this.screensEl.classList.add('hidden');
    document.body.classList.remove('in-menu');
    document.body.classList.add('in-match');
  }

  private openModal(s: Screen): void {
    this.closeModal();
    this.modal = s;
    this.screensEl.classList.remove('hidden');
    this.screensEl.appendChild(s.el);
    this.matchUi?.setBlocked(true);
  }

  private closeModal(): void {
    tooltip.hide();
    if (!this.modal) return;
    this.modal.dispose?.();
    this.modal.el.remove();
    this.modal = null;
    if (!this.screen) this.screensEl.classList.add('hidden');
    this.matchUi?.setBlocked(false);
  }

  private onKey(e: KeyboardEvent): void {
    const top = this.modal ?? this.screen;
    if (top?.onKey?.(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  toast(msg: string, kind: 'info' | 'error' = 'info'): void {
    const t = h('div', { class: `toast ${kind}` }, msg);
    this.toasts.appendChild(t);
    setTimeout(() => t.classList.add('gone'), 3200);
    setTimeout(() => t.remove(), 3800);
  }

  showMenu(code = ''): void {
    this.leaveLobby();
    const menu = new MenuScreen(
      {
        host: () => void this.host(),
        join: (c) => void this.join(c),
        skirmish: () => this.skirmish(),
        tutorial: () => this.tutorial(),
        replays: () => this.openReplays(),
        record: () => this.openModal(new RecordScreen(() => this.showMenu())),
        settings: () => this.openSettings(),
        credits: () => this.openModal(new CreditsScreen(() => this.closeModal())),
      },
      this.settings,
      code,
    );
    this.show(menu);
  }

  openReplays(): void {
    this.openModal(
      new ReplaysScreen(
        (r, name) => this.watchReplay(r, name),
        (r) => this.opts.downloadReplay?.(r),
        () => this.closeModal(),
      ),
    );
  }

  /** Watch a recorded match. `viewAs` picks whose eyes (fog of war) it is seen through. */
  watchReplay(replay: ReplayFile, _name = '', viewAs?: PlayerId): void {
    this.leaveLobby();
    this.disposeMatchUi();
    this.opts.onLeaveMatch?.();
    this.lobbyMode = 'replay';
    const localPlayer = viewAs ?? replay.setup.players.find((p) => p.kind === 'human')?.id ?? replay.setup.players[0]?.id ?? 0;
    this.loading = new LoadingScreen(replay.setup, this.opts.maps.find((m) => m.id === replay.setup.mapId), localPlayer, 'Replay');
    this.show(this.loading, false);
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      this.opts.onStartMatch(replay.setup, 'replay', { replay, localPlayer });
    };
    requestAnimationFrame(() => setTimeout(go, 30));
    setTimeout(go, 250);
  }

  /** Basic training: the tutorial map against a passive opponent, with the director on top. */
  tutorial(): void {
    const lobby = createSkirmishLobby(this.settings.get().playerName, this.opts.maps);
    this.enterLobby(lobby, 'tutorial');
    const map = this.opts.maps.find((m) => m.id === 'tutorial') ?? this.opts.maps.find((m) => m.id === 'sandbox') ?? this.opts.maps[0];
    lobby.setMap(map.id);
    lobby.setOccupancy(1, { ai: 'easy' });
    lobby.updateSlot(1, { team: 1 });
    lobby.start();
  }

  openSettings(): void {
    this.openModal(new SettingsScreen(this.settings, () => this.closeModal()));
  }

  // --- lobby

  private busyScreen(text: string, onCancel?: () => void): void {
    const el = h(
      'div',
      { class: 'screen busy-screen' },
      h('div', { class: 'busy-card panel' }, h('span', { class: 'spinner' }), h('span', { class: 'mono' }, text), onCancel ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: onCancel }, 'Cancel') : null),
    );
    this.show({ el });
  }

  private async host(): Promise<void> {
    let cancelled = false;
    this.busyScreen('Opening room…', () => {
      cancelled = true;
      this.showMenu();
    });
    try {
      const lobby = await this.connector.host(this.settings.get().playerName);
      if (cancelled) return lobby.leave();
      this.enterLobby(lobby, 'online');
    } catch (err) {
      if (!cancelled) {
        this.showMenu();
        this.toast(`Couldn't open a room: ${(err as Error).message}`, 'error');
      }
    }
  }

  private async join(code: string): Promise<void> {
    let cancelled = false;
    this.busyScreen(`Joining ${code}…`, () => {
      cancelled = true;
      history.replaceState(null, '', location.pathname + location.search);
      this.showMenu();
    });
    try {
      const lobby = await this.connector.join(code, this.settings.get().playerName);
      if (cancelled) return lobby.leave();
      this.enterLobby(lobby, 'online');
    } catch (err) {
      if (cancelled) return;
      history.replaceState(null, '', location.pathname + location.search);
      this.showMenu(code);
      (this.screen as MenuScreen).showJoinError((err as Error).message || 'Could not join');
    }
  }

  private skirmish(): void {
    this.enterLobby(createSkirmishLobby(this.settings.get().playerName, this.opts.maps), 'skirmish');
  }

  /**
   * Dev/test shortcut: skirmish on `mapId` against the given AIs, started at once. `teams` gives each
   * slot's team (self first); default is everyone on their own team.
   */
  quickSkirmish(mapId: string, ais: AiDifficulty[] = ['normal'], teams?: number[]): void {
    const lobby = createSkirmishLobby(this.settings.get().playerName, this.opts.maps);
    this.enterLobby(lobby, 'skirmish');
    lobby.setMap(mapId);
    ais.forEach((d, i) => lobby.setOccupancy(i + 1, { ai: d }));
    teams?.forEach((team, i) => lobby.updateSlot(i, { team }));
    lobby.start();
  }

  private enterLobby(lobby: LobbyApi, mode: MatchMode): void {
    this.leaveLobby();
    this.lobby = lobby;
    this.lobbyMode = mode;
    const code = lobby.getState().code;
    if (code) history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
    lobby.subscribe((s) => {
      if (s.status === 'closed' && this.lobby === lobby && !this.matchUi) {
        this.showMenu();
        if (s.error) this.toast(s.error, 'error');
      }
    });
    lobby.onStart((setup) => this.beginMatch(setup));
    this.show(
      new LobbyScreen({
        lobby,
        maps: this.opts.maps,
        mode,
        onLeave: () => this.showMenu(),
        toast: (m) => this.toast(m),
      }),
    );
  }

  private leaveLobby(): void {
    if (!this.lobby) return;
    const l = this.lobby;
    this.lobby = null;
    l.leave();
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  private beginMatch(setup: MatchSetup): void {
    const lobby = this.lobby!;
    const localPlayer = selfPlayerId(lobby.getState());
    const map = this.opts.maps.find((m) => m.id === setup.mapId);
    this.loading = new LoadingScreen(setup, map, localPlayer, this.lobbyMode === 'tutorial' ? 'Basic training' : this.lobbyMode === 'online' ? 'Online operation' : 'Operation');
    this.show(this.loading, false);
    // Let the loading screen paint before the match setup blocks the main thread. Background tabs
    // get no rAF, so a timer also fires: a peer that alt-tabbed must still start, or everyone stalls.
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      this.opts.onStartMatch(setup, this.lobbyMode, { lobby, localPlayer });
    };
    requestAnimationFrame(() => setTimeout(go, 30));
    setTimeout(go, 250);
  }

  /** 0..1 while the match loads. No-op once the HUD is up. */
  setLoadingProgress(fraction: number, label?: string): void {
    this.loading?.setProgress(fraction, label);
  }

  // --- match

  /**
   * Mount the HUD for a running match and drop the loading screen. The match runner keeps the
   * returned MatchUi and calls `handleEvents` after each sim step and `frame` each frame.
   */
  createMatchUi(ctx: Omit<MatchUiContext, 'root' | 'settings' | 'mode' | 'onMatchEnd' | 'openSettings'> & { mode?: MatchMode }): MatchUi {
    this.matchUi?.dispose();
    const quit = ctx.onQuit;
    const ui = new MatchUi({
      ...ctx,
      root: this.opts.root,
      settings: this.settings,
      mode: ctx.mode ?? this.lobbyMode,
      openSettings: () => this.openSettings(),
      onQuit: () => {
        quit?.();
        this.leaveMatch();
      },
      onMatchEnd: (r) => this.showResults(r),
    });
    this.matchUi = ui;
    // Move the screens layer above the HUD.
    this.opts.root.append(this.screensEl, this.toasts);
    const finish = () => {
      this.loading = null;
      this.hideScreens();
    };
    if (this.loading) {
      this.loading.setProgress(1, 'Deploying');
      setTimeout(finish, 450);
    } else finish();
    return ui;
  }

  showResults(result: MatchResult): void {
    this.disposeMatchUi();
    tooltip.hide();
    const mode = result.mode ?? this.lobbyMode;
    const replay = mode === 'replay' ? null : (this.opts.lastReplay?.() ?? null);
    let newMedals: ReturnType<typeof recordMatch>['newMedals'] = [];
    if (mode !== 'replay' && result.facts) {
      const mine = result.stats.find((s) => s.player === result.localPlayer);
      const myTeam = result.setup.players.find((p) => p.id === result.localPlayer)?.team;
      const won = result.winnerTeam === null ? null : result.winnerTeam === myTeam;
      if (mode === 'tutorial') result.facts.tutorial = true;
      const out = recordMatch(
        loadRecord(),
        {
          at: new Date().toISOString(),
          mapId: result.setup.mapId,
          mapName: result.mapName ?? result.setup.mapId,
          mode,
          won,
          durationSec: result.durationSec,
          kills: mine?.kills ?? 0,
          lost: mine?.unitsLost ?? 0,
          produced: mine?.unitsProduced ?? 0,
          built: mine?.structuresBuilt ?? 0,
          captures: mine?.pointsCaptured ?? 0,
          damage: mine?.damageDealt ?? 0,
          vsAi: result.facts.vsAi,
          players: result.setup.players.length,
        },
        result.facts,
      );
      saveRecord(out.record);
      newMedals = out.newMedals;
      if (replay && mode !== 'tutorial') {
        storeReplay({
          savedAt: new Date().toISOString(),
          mapName: result.mapName ?? result.setup.mapId,
          durationSec: result.durationSec,
          players: result.setup.players.map((p) => ({ name: p.name, color: p.color, team: p.team })),
          won,
          replay,
        });
      }
    }
    this.show(
      new ResultsScreen(result, () => this.leaveMatch(), {
        newMedals,
        saveReplay: replay && this.opts.downloadReplay ? () => this.opts.downloadReplay!(replay) : undefined,
        watchReplay: replay ? () => this.watchReplay(replay, '', result.localPlayer) : undefined,
      }),
    );
  }

  private disposeMatchUi(): void {
    this.matchUi?.dispose();
    this.matchUi = null;
  }

  /** Back to the title screen after a match. Calls onLeaveMatch so main can dispose the match. */
  leaveMatch(): void {
    this.disposeMatchUi();
    this.opts.onLeaveMatch?.();
    this.showMenu();
  }
}
