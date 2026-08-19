/**
 * Where the client looks for a game server.
 *
 * Baked at build time by Vite from `VITE_SERVER_URL`, and EMPTY by default. Empty means
 * single player: the game runs its own simulation in the tab, exactly as it always has,
 * so `npm run dev` needs no server running and the offline experience is not contingent
 * on any of the netcode being reachable.
 *
 *   VITE_SERVER_URL=wss://overstrike-gs.fly.dev npm run build
 *
 * Note `wss://`, not `ws://`: the site is served over HTTPS and a browser refuses a
 * plaintext socket from a secure page. Fly terminates TLS, so the server itself still
 * listens on plain HTTP inside the machine.
 */
const RAW = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SERVER_URL) || '';

export const SERVER_URL = String(RAW).trim();

/** True when this build was pointed at a server. */
export const HAS_SERVER = SERVER_URL.length > 0;

/**
 * Resolve the URL to connect to.
 *
 * A `?server=` query parameter overrides the baked-in value, which is what makes it
 * possible to point a shipped build at a local server without rebuilding — the two-client
 * test does exactly this.
 */
export function resolveServerUrl(search = (typeof location !== 'undefined' ? location.search : '')) {
  try {
    const q = new URLSearchParams(search).get('server');
    if (q) return q;
  } catch { /* no URL API, or a malformed query */ }
  return SERVER_URL;
}
