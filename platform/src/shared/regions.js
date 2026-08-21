/**
 * The regions this deployment can host matches in.  contracts/http-api.md §11.6.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * The allowlist `['yyz', 'ord', 'iad']` was written out three times — the `matchServerRegion`
 * enum in `core/config.js`, the match-server registration guard, and the room-create validator.
 * Three copies of one rule is how the mail requirement came to be enforced in two places and
 * relaxed in one, and how the launch refusal ended up stated three times with two of them
 * wrong. Adding a region meant finding all three; missing one produced a region that could
 * register a server but not host a room, or the reverse.
 *
 * ── The labels are not decoration ────────────────────────────────────────────────────────
 * `yyz` / `ord` / `iad` are Fly datacenter codes. They are the wire values and they must stay
 * the wire values, but no player knows them. The deployed room-create form asked for a free-text
 * "Region" and a player typed "Canada" and then "US"; both were rejected as `VALIDATION_FAILED`
 * with no indication of what would have been accepted. A closed set the server owns is exactly
 * the thing that should arrive as a list the client can render, which is what §11.6's
 * `GET /v1/config/regions` is for.
 *
 * `id` is what goes on the wire. `label` is what a person reads. Nothing derives one from the
 * other, so a code can be renamed without silently changing what a player sees.
 */

/** §11.6, ordered north-to-south so the list is stable rather than incidental. */
export const REGIONS = Object.freeze([
  Object.freeze({ id: 'yyz', label: 'Toronto' }),
  Object.freeze({ id: 'ord', label: 'Chicago' }),
  Object.freeze({ id: 'iad', label: 'Ashburn, Virginia' }),
]);

/** The wire values, for enum validation. Frozen so a caller cannot sort or push into it. */
export const REGION_IDS = Object.freeze(REGIONS.map((region) => region.id));

export function isRegion(value) {
  return typeof value === 'string' && REGION_IDS.includes(value);
}

export function regionLabel(id) {
  return REGIONS.find((region) => region.id === id)?.label ?? null;
}
