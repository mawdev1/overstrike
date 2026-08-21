import {
  createObservability, parseTraceparent, traceIdForCorrelation, traceparentForCorrelation,
} from '../src/core/observability.js';

let failures = 0;
const check = (condition, label, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

const correlationId = '01M0D000000000000000000001';
const traceparent = traceparentForCorrelation(correlationId);
const parsed = parseTraceparent(traceparent);
check(parsed?.traceId === traceIdForCorrelation(correlationId)
  && /^[0-9a-f]{16}$/.test(parsed.parentSpanId),
'correlation ids deterministically bridge correlation-only realtime frames into W3C traces');
check(parseTraceparent('00-00000000000000000000000000000000-1111111111111111-01') === null
  && parseTraceparent('garbage') === null,
'zero or malformed W3C trace context is rejected');

let now = Date.parse('2026-08-20T12:00:00Z');
const lines = [];
const logger = { info(event, fields) { lines.push({ level: 'info', event, fields }); },
  warn(event, fields) { lines.push({ level: 'warn', event, fields }); },
  error(event, fields) { lines.push({ level: 'error', event, fields }); } };
const sent = [];
const obs = createObservability({ service: 'platform', clock: { now: () => now }, logger,
  maxSpans: 2, alertCooldownMs: 1000, alertWebhookUrl: 'https://alerts.invalid/secret-route',
  fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 202 }; } });

obs.recordSpan({ correlationId, traceparent, tier: 'client', name: 'client.action',
  attributes: { component: 'shell', email: 'person@example.invalid', token: 'secret' } });
const remote = obs.recordSpan({ correlationId, tier: 'match-server', name: 'control.allocate',
  traceId: parsed.traceId, spanId: '1234567890abcdef', parentSpanId: parsed.parentSpanId,
  attributes: { component: 'match-control', status: 201, chat: 'do not retain this' } });
const duplicate = obs.recordSpan({ correlationId, tier: 'match-server', name: 'duplicate',
  spanId: '1234567890abcdef' });
obs.recordSpan({ correlationId, tier: 'platform', name: 'platform.action' });
const timeline = obs.timelineSpans(correlationId);
check(remote?.traceId === parsed.traceId && duplicate === null
  && timeline.length === 2 && timeline.some((span) => span.tier === 'match-server'),
'remote game-server spans retain trace identity, dedupe, and stay bounded');
check(!JSON.stringify(timeline).includes('person@example.invalid')
  && !JSON.stringify(timeline).includes('secret') && !JSON.stringify(timeline).includes('do not retain'),
'the trace attribute allow-list drops email, tokens, chat, and arbitrary fields');

obs.recordRequest({ method: 'GET', path: `/v1/accounts/${correlationId}`, status: 503,
  ms: 12.5, correlationId, traceparent });
const metrics = obs.snapshot();
check(metrics.counters.some((row) => row.name === 'http_requests_total'
  && row.labels.path === '/v1/accounts/:id' && row.labels.status === '5xx')
  && metrics.requestLatencyMs[0].avgMs === 12.5,
'request metrics use bounded route templates and record latency without account ids');

const firstAlert = await obs.alert({ key: 'db-down', severity: 'critical',
  event: 'dependency.unavailable', correlationId, component: 'db', errorCode: 'SERVICE_UNAVAILABLE' });
const suppressed = await obs.alert({ key: 'db-down', severity: 'critical',
  event: 'dependency.unavailable', correlationId, component: 'db' });
check(firstAlert.delivered && suppressed.suppressed && sent.length === 1
  && sent[0].body.event === 'dependency.unavailable'
  && !JSON.stringify(lines).includes('secret-route'),
'alerts route a closed redacted payload, suppress storms, and never log the secret webhook URL');

const echoSecret = 'https://alerts.invalid/key-that-must-never-be-logged';
const failedLines = [];
const failedLogger = { info() {}, warn() {}, error(event, fields) {
  failedLines.push({ event, fields });
} };
const failedObs = createObservability({ service: 'platform', clock: { now: () => now },
  logger: failedLogger, alertWebhookUrl: echoSecret,
  fetchImpl: async (url) => { throw new Error(`fetch failed for ${url}`); } });
const failedAlert = await failedObs.alert({ key: 'transport-down', severity: 'critical',
  event: 'alert.transport_down', correlationId });
check(!failedAlert.delivered && failedLines.length === 2
  && failedLines[1].event === 'alert.delivery_failed'
  && JSON.stringify(failedLines[1].fields) === JSON.stringify({
    event: 'alert.transport_down', correlationId, reason: 'transport',
  })
  && !JSON.stringify(failedLines).includes(echoSecret)
  && !JSON.stringify(failedLines).includes('key-that-must-never-be-logged'),
'alert transport failures log only a closed reason even when fetch echoes a secret-bearing URL');

const noRoute = createObservability({ clock: { now: () => now }, logger });
check((await noRoute.health()).ok === false && (await obs.health()).ok === true,
'production readiness can fail closed when alert routing is unconfigured');

if (failures) process.exit(1);
console.log('observability baseline checks passed');
