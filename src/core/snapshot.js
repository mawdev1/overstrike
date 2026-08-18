/**
 * Declarative snapshot / restore.
 *
 * Reconciliation replays a tick: put the entity back exactly as it was, feed the command
 * again, and the result must match what the server got. That only works if "exactly as it
 * was" is complete — and a Player carries ~70 mutable fields across movement, eye springs,
 * aim, stance, timers and command state. Hand-rolling save/restore for that many fields
 * means one of them eventually gets missed, and a missed field does not fail loudly: it
 * produces occasional rubber-banding, weeks later, under conditions nobody can reproduce.
 *
 * So the field list is declared once, per class, and save/restore are generated from it.
 * The declaration is the documentation, and `audit()` below turns "someone added a field
 * and forgot the manifest" from a latent desync into a failing test.
 *
 * Three kinds, because three things copy differently:
 *   - `scalars`  numbers, booleans, strings. Assigned.
 *   - `vec3s`    anything with x/y/z. Copied COMPONENT-WISE — assigning the reference
 *                would alias the snapshot to the live entity, so "restoring" would write
 *                back whatever the entity currently holds and silently do nothing.
 *   - `objects`  plain sub-objects reused in place (`_held`, `_edge`, `stats`). Same
 *                aliasing trap, one level down, so their keys are declared too.
 *
 * Everything else must be named in `ignore`, with a comment saying why. There is no
 * "unlisted means excluded" default: that is precisely the rule that lets a new field slip
 * through unnoticed.
 */

/**
 * @param {string} className  for error messages
 * @param {{scalars?: string[], vec3s?: string[], objects?: Record<string,string[]>, ignore?: string[]}} spec
 */
export function defineSnapshot(className, spec) {
  const scalars = spec.scalars || [];
  const vec3s = spec.vec3s || [];
  const objects = spec.objects || {};
  const ignore = spec.ignore || [];
  const objectNames = Object.keys(objects);

  const captured = [...scalars, ...vec3s, ...objectNames];
  const known = new Set([...captured, ...ignore]);

  // A field listed twice is a merge accident, and the symptom (one copy silently winning)
  // is invisible. Catch it at module load, where the stack trace still says who did it.
  const seen = new Set();
  for (const name of [...captured, ...ignore]) {
    if (seen.has(name)) throw new Error(`${className} snapshot: "${name}" is declared twice`);
    seen.add(name);
  }

  /** Capture `inst` into `out` (reused across calls — this runs per entity per tick). */
  function save(inst, out) {
    const o = out || {};
    for (let i = 0; i < scalars.length; i++) {
      const k = scalars[i];
      o[k] = inst[k];
    }
    for (let i = 0; i < vec3s.length; i++) {
      const k = vec3s[i];
      const v = inst[k];
      const t = o[k] || (o[k] = { x: 0, y: 0, z: 0, _null: false });
      // A nullable vec3 must not turn a snapshot into a mid-tick crash. Record the
      // absence instead, so restore can reproduce it.
      if (v == null) { t._null = true; t.x = t.y = t.z = 0; continue; }
      t._null = false;
      t.x = v.x; t.y = v.y; t.z = v.z;
    }
    for (let i = 0; i < objectNames.length; i++) {
      const k = objectNames[i];
      const keys = objects[k];
      const src = inst[k];
      const t = o[k] || (o[k] = {});
      for (let j = 0; j < keys.length; j++) t[keys[j]] = src[keys[j]];
    }
    return o;
  }

  /** Write a snapshot back onto `inst`, in place. */
  function restore(inst, snap) {
    for (let i = 0; i < scalars.length; i++) {
      const k = scalars[i];
      inst[k] = snap[k];
    }
    for (let i = 0; i < vec3s.length; i++) {
      const k = vec3s[i];
      const s = snap[k];
      if (s._null) { inst[k] = null; continue; }
      const v = inst[k];
      // The field may have been null when this snapshot was taken over; there is no
      // Vector3 to write into, so hand back a plain carrier rather than throwing.
      if (v == null) { inst[k] = { x: s.x, y: s.y, z: s.z }; continue; }
      v.x = s.x; v.y = s.y; v.z = s.z;
    }
    for (let i = 0; i < objectNames.length; i++) {
      const k = objectNames[i];
      const keys = objects[k];
      const s = snap[k];
      const dst = inst[k];
      for (let j = 0; j < keys.length; j++) dst[keys[j]] = s[keys[j]];
    }
    return inst;
  }

  /**
   * Field-by-field comparison of two snapshots, for the bit-equality harness: at zero
   * latency, predicted state and authoritative state must be identical, and when they are
   * not, the useful output is WHICH field diverged, not that something did.
   *
   * `Object.is` rather than `===` so a NaN that appears on both sides reads as agreement
   * (it is the same state) while `+0` against `-0` reads as divergence (it is not — it
   * flips the sign of anything that divides by it).
   */
  function diff(a, b, out) {
    const list = out || [];
    list.length = 0;
    for (let i = 0; i < scalars.length; i++) {
      const k = scalars[i];
      if (!Object.is(a[k], b[k])) list.push(k);
    }
    for (let i = 0; i < vec3s.length; i++) {
      const k = vec3s[i];
      const x = a[k], y = b[k];
      if (!Object.is(x._null, y._null) || !Object.is(x.x, y.x)
        || !Object.is(x.y, y.y) || !Object.is(x.z, y.z)) list.push(k);
    }
    for (let i = 0; i < objectNames.length; i++) {
      const k = objectNames[i];
      const keys = objects[k];
      const x = a[k], y = b[k];
      // Every differing key, not just the first. `_edge` has 15 and `_held` 10; stopping
      // at one would mean re-running to find the rest, which is the opposite of the point.
      for (let j = 0; j < keys.length; j++) {
        if (!Object.is(x[keys[j]], y[keys[j]])) list.push(`${k}.${keys[j]}`);
      }
    }
    return list;
  }

  /**
   * Own enumerable fields on `inst` that the manifest neither captures nor ignores.
   *
   * This is the whole point of declaring the list. Someone adding a field to Player in six
   * months will not think about reconciliation, and nothing about their change will look
   * wrong — the desync shows up as a rare visual glitch in a mode they were not testing.
   * A test calling `audit()` on a live instance turns that into a failure on their branch.
   *
   * Only own enumerable properties are visible here, so getters on the prototype
   * (`slideDip`, `adsTime`, the `grenades` accessor) are correctly invisible: they are
   * derived and have nothing to restore. Fields another system monkey-patches on
   * (`blind`/`deaf` from flashbangs) DO show up, and must be classified like any other.
   */
  function audit(inst) {
    const missing = [];
    for (const k of Object.keys(inst)) if (!known.has(k)) missing.push(k);
    // The mirror-image error, and the same class of bug: a name in the manifest that is
    // not on the instance. A mistyped scalar is the dangerous one — `save` records
    // `undefined` and `restore` writes `undefined` back, permanently and silently, while
    // the manifest reads as though the field were covered.
    const stale = [];
    for (let i = 0; i < captured.length; i++) {
      if (!(captured[i] in inst)) stale.push(captured[i]);
    }
    return { missing, stale, ok: missing.length === 0 && stale.length === 0 };
  }

  /**
   * Keys a snapshot is missing, for data that has crossed a wire.
   *
   * Not called from `restore`, which runs per entity per tick and must stay a straight
   * copy — but a snapshot arriving as JSON can lose a key to a version skew or a rename,
   * and `restore` would then write `undefined` into a scalar without complaint.
   */
  function verify(snap) {
    const absent = [];
    for (let i = 0; i < captured.length; i++) {
      if (snap[captured[i]] === undefined) absent.push(captured[i]);
    }
    for (let i = 0; i < objectNames.length; i++) {
      const k = objectNames[i];
      const sub = snap[k];
      if (!sub) continue;
      const keys = objects[k];
      for (let j = 0; j < keys.length; j++) {
        if (sub[keys[j]] === undefined) absent.push(`${k}.${keys[j]}`);
      }
    }
    return absent;
  }

  return { className, save, restore, diff, audit, verify, captured, known };
}
