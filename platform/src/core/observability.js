/**
 * Small, dependency-free P1 observability baseline.
 *
 * This is deliberately an instrumentation boundary rather than a vendor SDK. It emits W3C
 * trace context, keeps bounded process metrics/recent spans for service-only inspection, and
 * routes a narrowly-shaped alert payload to the configured operations webhook. Durable domain
 * facts remain in the outbox/audit tables; recent spans are diagnostic and may disappear on a
 * restart.
 */
import { createHash, randomBytes } from 'node:crypto';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

const hex = (value, bytes) => createHash('sha256').update(String(value)).digest('hex').slice(0, bytes * 2);

/** A stable trace id lets correlation-only WebSocket frames rejoin the HTTP trace. */
export const traceIdForCorrelation = (correlationId) => hex(`overstrike:${correlationId}`, 16);

export function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match || match[1] === ZERO_TRACE || match[2] === ZERO_SPAN) return null;
  return { traceId: match[1], parentSpanId: match[2], flags: match[3] };
}

export function traceparentForCorrelation(correlationId, parent = 'client') {
  const traceId = traceIdForCorrelation(correlationId);
  const spanId = hex(`${parent}:${correlationId}`, 8);
  return `00-${traceId}-${spanId}-${'01'}`;
}

const statusClass = (status) => `${Math.floor(Number(status || 0) / 100)}xx`;
const safePath = (path) => typeof path === 'string' && path.startsWith('/v1/')
  ? path.replace(/\/[0-9A-HJKMNP-TV-Z]{26}(?=\/|$)/g, '/:id') : '-';

const safeAttributes = (attributes = {}) => {
  const out = {};
  // Deliberately closed. Arbitrary attributes are where email, tokens, chat and provider
  // response bodies leak into tracing systems.
  for (const key of ['method', 'path', 'status', 'statusClass', 'component', 'eventType',
    'outcome', 'errorCode', 'retryable']) {
    const value = attributes[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = key === 'path' ? safePath(value) : value;
    }
  }
  return out;
};

export function createObservability({ service = 'platform', clock = Date, logger,
  alertWebhookUrl = '', fetchImpl = globalThis.fetch, maxSpans = 5000,
  alertCooldownMs = 60_000 } = {}) {
  const startedAt = clock.now();
  const counters = new Map();
  const requestLatency = new Map();
  const spans = [];
  const alertLastSent = new Map();
  const alertStats = { attempted: 0, delivered: 0, failed: 0, suppressed: 0 };

  const inc = (name, labels = {}, amount = 1) => {
    const ordered = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
    const key = `${name}|${JSON.stringify(ordered)}`;
    const prior = counters.get(key) || { name, labels: ordered, value: 0 };
    prior.value += amount;
    counters.set(key, prior);
  };

  function recordSpan({ correlationId, traceparent = null, tier = service, name,
    traceId: suppliedTraceId = null, spanId: suppliedSpanId = null,
    parentSpanId: suppliedParentSpanId = null,
    status = 'ok', durationMs = null, attributes = {} }) {
    const parsed = parseTraceparent(traceparent);
    const traceId = /^[0-9a-f]{32}$/.test(suppliedTraceId || '')
      ? suppliedTraceId : parsed?.traceId || traceIdForCorrelation(correlationId);
    const parentSpanId = /^[0-9a-f]{16}$/.test(suppliedParentSpanId || '')
      ? suppliedParentSpanId : parsed?.parentSpanId || null;
    const spanId = /^[0-9a-f]{16}$/.test(suppliedSpanId || '')
      ? suppliedSpanId : randomBytes(8).toString('hex');
    if (spans.some((prior) => prior.tier === tier && prior.spanId === spanId)) return null;
    const span = Object.freeze({
      traceId,
      spanId,
      parentSpanId,
      correlationId,
      tier,
      name,
      status,
      durationMs: durationMs === null ? null : Math.max(0, Number(durationMs) || 0),
      at: new Date(clock.now()).toISOString(),
      attributes: safeAttributes(attributes),
    });
    spans.push(span);
    if (spans.length > maxSpans) spans.splice(0, spans.length - maxSpans);
    logger?.info?.('trace.span', span);
    return span;
  }

  function recordRequest({ method, path, status, ms, correlationId, traceparent = null }) {
    const labels = { method: String(method || '-'), path: safePath(path), status: statusClass(status) };
    inc('http_requests_total', labels);
    const key = JSON.stringify({ method: labels.method, path: labels.path });
    const latency = requestLatency.get(key) || { labels: { method: labels.method, path: labels.path },
      count: 0, sumMs: 0, maxMs: 0 };
    latency.count += 1; latency.sumMs += ms; latency.maxMs = Math.max(latency.maxMs, ms);
    requestLatency.set(key, latency);
    return recordSpan({ correlationId, traceparent, tier: service, name: 'http.request',
      status: Number(status) >= 500 ? 'error' : 'ok', durationMs: ms,
      attributes: { method: labels.method, path: labels.path, status, statusClass: labels.status } });
  }

  function recordOutbox(pass) {
    for (const key of ['published', 'failed', 'deadLettered']) {
      if (pass?.[key]) inc(`outbox_${key === 'deadLettered' ? 'dead_lettered' : key}_total`, {}, pass[key]);
    }
  }

  async function alert({ key, severity = 'warning', event, correlationId = null,
    component = service, errorCode = null, count = null }) {
    const now = clock.now();
    if (now - (alertLastSent.get(key) ?? -Infinity) < alertCooldownMs) {
      alertStats.suppressed++; inc('alerts_suppressed_total', { event });
      return { delivered: false, suppressed: true };
    }
    alertLastSent.set(key, now);
    alertStats.attempted++; inc('alerts_attempted_total', { event, severity });
    const body = { version: 1, service, environment: process.env.NODE_ENV || 'development',
      severity, event, component, correlationId, errorCode, count,
      occurredAt: new Date(now).toISOString() };
    // Never log or return the webhook URL. It commonly embeds a routing credential.
    logger?.[severity === 'critical' ? 'error' : 'warn']?.('alert.routed', body);
    if (!alertWebhookUrl || typeof fetchImpl !== 'function') {
      alertStats.failed++; inc('alerts_failed_total', { event, reason: 'unconfigured' });
      return { delivered: false, suppressed: false };
    }
    try {
      const response = await fetchImpl(alertWebhookUrl, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`alert transport returned ${response.status}`);
      alertStats.delivered++; inc('alerts_delivered_total', { event });
      return { delivered: true, suppressed: false };
    } catch {
      alertStats.failed++; inc('alerts_failed_total', { event, reason: 'transport' });
      // Fetch errors commonly echo the complete request URL, including a routing credential.
      // The failure class is actionable; the exception text is neither safe nor bounded.
      logger?.error?.('alert.delivery_failed', { event, correlationId, reason: 'transport' });
      return { delivered: false, suppressed: false };
    }
  }

  function snapshot() {
    return {
      service,
      uptimeSec: Math.floor((clock.now() - startedAt) / 1000),
      counters: [...counters.values()].map((row) => ({ ...row, labels: { ...row.labels } })),
      requestLatencyMs: [...requestLatency.values()].map((row) => ({ ...row,
        labels: { ...row.labels }, avgMs: row.count ? row.sumMs / row.count : 0 })),
      alerts: { ...alertStats, configured: Boolean(alertWebhookUrl) },
      recentSpanCount: spans.length,
    };
  }

  const timelineSpans = (correlationId) => spans.filter((span) => span.correlationId === correlationId)
    .map((span) => ({ ...span, attributes: { ...span.attributes } }));

  return {
    inc, recordSpan, recordRequest, recordOutbox, alert, snapshot, timelineSpans,
    health: async () => ({ ok: Boolean(alertWebhookUrl), detail: alertWebhookUrl ? 'configured' : 'unconfigured' }),
  };
}
