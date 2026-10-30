// Installable app support: registers the service worker in production builds and keeps the browser's
// install prompt so the main menu can offer an "Install app" button.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** True when the game is already running as an installed app window. */
export function isInstalled(): boolean {
  return matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
}

/** True when the browser will show its install dialog if asked. */
export function canInstall(): boolean {
  return deferred !== null && !isInstalled();
}

/** Shows the browser's install dialog. Resolves true if the player accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferred;
  if (!ev) return false;
  deferred = null;
  notify();
  await ev.prompt();
  return (await ev.userChoice).outcome === 'accepted';
}

/** Calls `fn` whenever installability changes; returns an unsubscribe function. */
export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initInstall(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for our menu button instead of the browser's mini-bar
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  }
}
