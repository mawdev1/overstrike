/**
 * Telemetry module.  contracts/telemetry.md §3.
 *
 * Client telemetry only. Server telemetry (§4) is metrics, and metrics never touch the
 * database — confusing the two is how a platform ends up writing counters per tick.
 */
export {
  REGISTRY, lookupEvent, isPersonal, UNSUPPORTED_REASONS, CLIENT_ERROR_CLASSES,
  CONNECTION_FAILURE_CODES,
  SETTINGS_CATEGORY_IDS, SETTINGS_VOCABULARY_VERSION,
} from './registry.js';
export { LIMITS, validatePayload, validateBatchShape, enforcePreconsentRules, checkFreshness } from './validate.js';
export { createConsentReceipts } from './consent.js';
export { createTelemetryService, registerTelemetryRoutes, createCorrelationSeen } from './service.js';
export { createUnloadIngress, registerUnloadRoutes } from './unload.js';
