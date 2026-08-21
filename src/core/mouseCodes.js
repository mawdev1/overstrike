/**
 * DOM mouse button number → the bind code players and settings use.
 *
 * ── The defect this exists to end ────────────────────────────────────────────────────────
 * Five call sites each wrote `` `Mouse${button + 1}` ``, which yields Mouse1=left,
 * Mouse2=MIDDLE, Mouse3=right. Every shipped FPS — and every player — reads Mouse2 as the
 * RIGHT button, and this codebase already assumed that: the defaults pair `fire: Mouse1` with
 * `aim: Mouse2`, which is the left/right pairing, not left/middle.
 *
 * The result was that aim-down-sights sat on the middle mouse button and right-click did
 * nothing at all. Firing worked, because left-click is Mouse1 under either reading, so the
 * input system looked fine right up until someone tried to aim. Reported from the deployed
 * build, not caught here: the five sites agreed with each other, so nothing was inconsistent
 * for a test to notice — they were uniformly wrong, which is the harder kind.
 *
 * The bind CAPTURE path used the same arithmetic, so rebinding aim by right-clicking stored
 * `Mouse3` and then worked. That is why this could not be found by rebinding — the only broken
 * configuration was the default one, which is the one every new player has.
 *
 * ── Why a table and not arithmetic ───────────────────────────────────────────────────────
 * There is no offset that produces this mapping; 1 and 2 swap and the rest pass through. An
 * expression that looks like a formula invites the next reader to simplify it back into the
 * bug. Side buttons keep their conventional numbers: DOM 3 and 4 are Mouse4 and Mouse5.
 */

/** DOM `MouseEvent.button` → bind code. Index is the DOM number. */
const CODES = Object.freeze(['Mouse1', 'Mouse3', 'Mouse2', 'Mouse4', 'Mouse5']);

/**
 * `null` for anything outside the five buttons a browser reports, so a caller cannot
 * accidentally mint a binding for a device event it does not understand.
 */
export function mouseCode(button) {
  return Number.isInteger(button) && button >= 0 && button < CODES.length ? CODES[button] : null;
}
