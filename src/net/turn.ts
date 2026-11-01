/**
 * TURN relay servers, for networks that only allow ports 80/443 and block direct WebRTC.
 * When a direct connection fails, game data is relayed through TURN over TLS on port 443.
 *
 * The credentials come from Metered's free tier: the URL below returns a list of ICE servers.
 * It can be overridden per browser with `?turn=<url or JSON iceServers>` (remembered in
 * localStorage; `?turn=` with nothing clears it). An empty value means STUN only.
 */
export const DEFAULT_TURN_SOURCE =
  'https://cultivation.metered.live/api/v1/turn/credentials?apiKey=7159975908ce81062958fa816b7d0a6cffc9';

const STORAGE_KEY = 'frontline.turn';
const CACHE_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Where to get TURN servers from: `?turn=`, then localStorage, then the default. */
export function turnSource(): string {
  let q: string | null = null;
  try {
    if (typeof location !== 'undefined') q = new URLSearchParams(location.search).get('turn');
  } catch {
    // No location (tests, workers).
  }
  try {
    if (q !== null) {
      if (q) localStorage.setItem(STORAGE_KEY, q);
      else localStorage.removeItem(STORAGE_KEY);
    }
    return (q ?? localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TURN_SOURCE).trim();
  } catch {
    return (q ?? DEFAULT_TURN_SOURCE).trim();
  }
}

/** Accepts an array of ICE servers, `{ iceServers: [...] }` or a single server object. */
export function parseIceServers(json: unknown): RTCIceServer[] {
  const raw = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { iceServers?: unknown }).iceServers)
      ? (json as { iceServers: unknown[] }).iceServers
      : [json];
  return raw.filter(
    (s): s is RTCIceServer => !!s && typeof s === 'object' && (typeof (s as RTCIceServer).urls === 'string' || Array.isArray((s as RTCIceServer).urls)),
  );
}

let cached: { at: number; servers: Promise<RTCIceServer[]> } | null = null;

/**
 * TURN servers to add to the RTC config. Never rejects: on any failure it resolves to `[]`
 * so the game falls back to direct connections. Fetched once and reused for 30 minutes.
 */
export function getTurnServers(source: string = turnSource()): Promise<RTCIceServer[]> {
  if (!source) return Promise.resolve([]);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.servers;
  const servers = (async () => {
    try {
      let json: unknown;
      if (/^[[{]/.test(source)) json = JSON.parse(source);
      else {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        try {
          json = await (await fetch(source, { signal: ctl.signal, cache: 'no-store' })).json();
        } finally {
          clearTimeout(timer);
        }
      }
      const list = parseIceServers(json);
      if (!list.length) throw new Error('no ICE servers in response');
      return list;
    } catch (err) {
      console.warn('[net] TURN relay unavailable, using direct connections only', err);
      cached = null;
      return [];
    }
  })();
  cached = { at: now, servers };
  return servers;
}
