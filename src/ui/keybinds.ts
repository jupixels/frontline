// Rebindable hotkeys. Bindings are KeyboardEvent.code values (physical keys), so they work the
// same on every keyboard layout. Control groups stay on the digit row and are not rebindable.

export type ActionId =
  | 'attackMove'
  | 'stop'
  | 'hold'
  | 'patrol'
  | 'build'
  | 'rotateStructure'
  | 'centerSelection'
  | 'selectArmy'
  | 'jumpAlert'
  | 'menu'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'slot6'
  | 'slot7'
  | 'slot8';

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: 'Orders' | 'Command card' | 'Camera & selection' | 'Interface';
  key: string;
}

export const ACTIONS: readonly ActionInfo[] = [
  { id: 'attackMove', label: 'Attack-move', group: 'Orders', key: 'KeyA' },
  { id: 'stop', label: 'Stop', group: 'Orders', key: 'KeyS' },
  { id: 'hold', label: 'Hold position', group: 'Orders', key: 'KeyH' },
  { id: 'patrol', label: 'Patrol', group: 'Orders', key: 'KeyP' },
  { id: 'build', label: 'Build menu', group: 'Orders', key: 'KeyB' },
  { id: 'rotateStructure', label: 'Rotate structure', group: 'Orders', key: 'KeyR' },
  { id: 'slot1', label: 'Slot 1', group: 'Command card', key: 'KeyQ' },
  { id: 'slot2', label: 'Slot 2', group: 'Command card', key: 'KeyW' },
  { id: 'slot3', label: 'Slot 3', group: 'Command card', key: 'KeyE' },
  { id: 'slot4', label: 'Slot 4', group: 'Command card', key: 'KeyR' },
  { id: 'slot5', label: 'Slot 5', group: 'Command card', key: 'KeyT' },
  { id: 'slot6', label: 'Slot 6', group: 'Command card', key: 'KeyY' },
  { id: 'slot7', label: 'Slot 7', group: 'Command card', key: 'KeyU' },
  { id: 'slot8', label: 'Slot 8', group: 'Command card', key: 'KeyI' },
  { id: 'centerSelection', label: 'Center on selection', group: 'Camera & selection', key: 'KeyF' },
  { id: 'selectArmy', label: 'Select all army', group: 'Camera & selection', key: 'F2' },
  { id: 'jumpAlert', label: 'Jump to last alert', group: 'Camera & selection', key: 'Space' },
  { id: 'menu', label: 'Game menu', group: 'Interface', key: 'F10' },
];

export const SLOT_ACTIONS: readonly ActionId[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8'];

export type Keybinds = Record<ActionId, string>;

export function defaultKeybinds(): Keybinds {
  const out = {} as Keybinds;
  for (const a of ACTIONS) out[a.id] = a.key;
  return out;
}

/**
 * Actions that are live at the same time, so they must not share a key. Command card slots only
 * show up in sub-menus (build list, factory card) where unit orders are hidden, and
 * rotateStructure only works in placement mode, so those may overlap with orders.
 */
function contextOf(id: ActionId): 'orders' | 'slots' | 'place' | 'global' {
  if (id.startsWith('slot')) return 'slots';
  if (id === 'rotateStructure') return 'place';
  if (id === 'attackMove' || id === 'stop' || id === 'hold' || id === 'patrol' || id === 'build') return 'orders';
  return 'global';
}

function conflicts(a: ActionId, b: ActionId): boolean {
  if (a === b) return false;
  const ca = contextOf(a);
  const cb = contextOf(b);
  if (ca === 'global' || cb === 'global') return true;
  return ca === cb;
}

/**
 * Bind `code` to `action`. Any conflicting action that already used `code` gets `action`'s old
 * key instead (a swap), so no two live actions ever share a key.
 */
export function rebind(binds: Keybinds, action: ActionId, code: string): Keybinds {
  const next = { ...binds };
  const old = next[action];
  for (const a of ACTIONS) {
    if (next[a.id] === code && conflicts(a.id, action)) next[a.id] = old;
  }
  next[action] = code;
  return next;
}

/** Returns the action bound to `code` among `candidates` (first match wins). */
export function actionFor(binds: Keybinds, code: string, candidates: readonly ActionId[]): ActionId | null {
  for (const a of candidates) if (binds[a] === code) return a;
  return null;
}

const NAMED: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Bksp',
  CapsLock: 'Caps',
  ShiftLeft: 'LShift',
  ShiftRight: 'RShift',
  ControlLeft: 'LCtrl',
  ControlRight: 'RCtrl',
  AltLeft: 'LAlt',
  AltRight: 'RAlt',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/** Short label for a KeyboardEvent.code: "KeyA" → "A", "Digit1" → "1", "Numpad5" → "Num5". */
export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`;
  return NAMED[code] ?? code;
}

/** Keys that can't be bound: modifiers (used for queue/add/group) and the digit row (groups). */
export function isBindable(code: string): boolean {
  if (/^Digit\d$/.test(code)) return false;
  if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)) return false;
  if (code === 'Escape') return false;
  return code.length > 0;
}
