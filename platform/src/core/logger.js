/**
 * Structured logging.  Build Plan §P1.A7.
 *
 * JSON lines, one per event, always carrying the correlation id when the caller has one.
 * Never a formatted string: a log a human reads comfortably is a log a query cannot filter,
 * and the whole point of §2.3 is following one player action across three tiers.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', service = 'platform', sink = console } = {}) {
  const min = LEVELS[level] ?? 20;
  const emit = (lvl, event, fields) => {
    if (LEVELS[lvl] < min) return;
    const line = { ts: new Date().toISOString(), level: lvl, service, event, ...fields };
    // stdout for everything: the platform does not decide where logs go, the runtime does.
    sink.log(JSON.stringify(line));
  };
  return {
    debug: (e, f = {}) => emit('debug', e, f),
    info:  (e, f = {}) => emit('info', e, f),
    warn:  (e, f = {}) => emit('warn', e, f),
    error: (e, f = {}) => emit('error', e, f),
    child: (bound) => {
      const base = createLogger({ level, service, sink });
      return {
        debug: (e, f = {}) => base.debug(e, { ...bound, ...f }),
        info:  (e, f = {}) => base.info(e, { ...bound, ...f }),
        warn:  (e, f = {}) => base.warn(e, { ...bound, ...f }),
        error: (e, f = {}) => base.error(e, { ...bound, ...f }),
      };
    },
  };
}
