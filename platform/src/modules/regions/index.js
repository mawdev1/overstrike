/**
 * `GET /v1/config/regions` — the region list a client renders.  contracts/http-api.md §11.6.
 *
 * ── Why this module exists ───────────────────────────────────────────────────────────────
 * §11.6 has specified this endpoint since P1 and it was implemented only in the STUB layer, so
 * the deployed platform answered 404 to the one call that could have told a player what a valid
 * region is. The room-create form therefore shipped a free-text "Region" box; a player typed
 * "Canada", got `VALIDATION_FAILED`, typed "US", got it again, and nothing anywhere named
 * `yyz`, `ord` or `iad`. This is the identical failure `modules/flags` was written to fix — a
 * stub is a description of an implementation, not one, and the two had drifted until the
 * described endpoint existed and the real one did not.
 *
 * ── `available` is measured, never declared ──────────────────────────────────────────────
 * The stub fixture carried `available: true` as a literal. Here it is the answer to the same
 * question `POST /v1/rooms` asks before it accepts a region: is there a registered, healthy,
 * recently-heartbeating match server with spare capacity right now. Anything else would let the
 * dropdown offer a region that room creation then refuses — which is the state the deployment
 * was actually in, with `yyz` and `ord` in the allowlist and a server only in `iad`.
 *
 * The room-create check is deliberately NOT replaced by this one. That check runs inside the
 * request that allocates and must see the registry at that instant; this is a hint for a UI and
 * is a snapshot by nature. Two callers, one predicate, and the gap between them is a race the
 * client is expected to handle by reading the refusal — not something a longer cache would fix.
 *
 * ── probeUrl ─────────────────────────────────────────────────────────────────────────────
 * §11.6 has the client measure RTT against `probeUrl` itself. It is `null` for a region with no
 * registered server, because the alternative is naming a host that will not answer and letting
 * the client record a timeout as a latency. §11.6 is explicit that the server never invents a
 * ping from geography; inventing the endpoint that produces one is the same mistake one step
 * earlier.
 */
import { REGIONS } from '../../shared/regions.js';

/** §11.6 is a public route, so the cache is short and the answer is not per-account. */
const TTL_MS = 30_000;

/**
 * A registered match server's `address` is a WebSocket URL (`wss://host`). The probe is an
 * ordinary HTTP GET, so the scheme is mapped and the game server's own liveness path is used —
 * it is the one endpoint guaranteed to exist on every registered authority.
 *
 * Returns null rather than a guess for anything that does not parse.
 */
export function probeUrlFor(address) {
  if (typeof address !== 'string' || !address) return null;
  try {
    const url = new URL(address);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

export function createRegionsModule({ store, clock = () => Date.now(), heartbeatMs = 15_000 } = {}) {
  async function evaluate() {
    // Same staleness window the allocator uses: a row that stopped heartbeating two intervals
    // ago is not capacity, whatever its status column says.
    const since = new Date(clock() - heartbeatMs * 2).toISOString();
    const regions = await Promise.all(REGIONS.map(async ({ id, label }) => {
      let servers = [];
      try {
        servers = await store.matchServers?.healthy?.(id, since) ?? [];
      } catch {
        // A registry read failure must not 500 the region list. An unknown region reports
        // unavailable, which is the safe direction: it hides a region that might work rather
        // than offering one that cannot.
        servers = [];
      }
      return { id, label, probeUrl: probeUrlFor(servers[0]?.address), available: servers.length > 0 };
    }));
    return { regions };
  }

  const handlers = {
    async getRegions() {
      return evaluate();
    },
  };

  function routes(router) {
    // `P` in §3's table — the shell calls this before an account exists, on the create form.
    router.get('/v1/config/regions', handlers.getRegions);
    return router;
  }

  return { evaluate, handlers, routes, ttlMs: TTL_MS };
}
