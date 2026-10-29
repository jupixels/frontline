// Public surface of the UI workstream. src/main.ts and src/game/ import from here.
export { UiApp, type UiAppOptions, type StartInfo } from './app';
export { MatchUi, type MatchUiContext, type NetStatus, type RenderHooks, type CameraControl } from './hud/matchUi';
export { InputController, type InputOptions, type TargetMode } from './input';
export * from './lobbyApi';
export { SettingsStore, type Settings, type QualityPreset, type VolumeSettings } from './settings';
export { ACTIONS, type ActionId, type Keybinds } from './keybinds';
export { SimAdapter, FALLBACK_STRUCTURES, type StructureInfo } from './simAdapter';
export type { MatchResult, PlayerStats } from './screens/results';
