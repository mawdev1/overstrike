/** Central structured-log privacy boundary — auth, lobby, events, and observability callers. */
import { createLogger } from '../src/core/logger.js';
import { createObservability, traceparentForCorrelation } from '../src/core/observability.js';

let failures = 0;
const check = (condition, label, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

const rawAccount = '01M0A000000000000000000001';
const rawSubject = '01M0A000000000000000000002';
const rawRoom = '01M0A000000000000000000003';
const rawMatch = '01M0A000000000000000000004';
const rawEvent = '01M0A000000000000000000005';
const correlationId = '01M0A000000000000000000006';
const secretUrl = 'https://provider.invalid/hook/super-secret-route';
const bearer = 'Bearer platform-token-that-must-not-leak';
const email = 'person@example.invalid';

const lines = [];
const sink = { log(line) { lines.push(JSON.parse(line)); } };
const logger = createLogger({ level: 'debug', service: 'platform', sink });

// Exact shapes emitted today by auth and lobby. The unsafe values are deliberately repeated in
// several keys so a passing result proves a central rule, not one renamed caller.
logger.warn('session.reuse_detected', {
  familyId: rawSubject, accountId: rawAccount, correlationId,
  authorization: bearer, message: `provider failed at ${secretUrl}`,
});
logger.info('auth.verification.completed', { correlationId, accountId: rawAccount });
logger.error('lobby.launch.failed', {
  roomId: rawRoom, matchId: rawMatch, correlationId,
  message: `fetch ${secretUrl} with ${bearer}`,
  body: { email, token: bearer },
});
logger.info('report.created', {
  reportId: rawEvent, reporterAccountId: rawAccount, subjectAccountId: rawSubject,
  matchId: rawMatch, category: 'abuse', correlationId, description: email,
});

// Exact event/outbox/audit families. Operational classification survives, raw join keys and
// arbitrary publisher diagnostics do not.
logger.info('event.published', {
  eventId: rawEvent, type: 'match.completed', subjectKind: 'match', subjectId: rawMatch,
  correlationId,
});
logger.error('outbox.dead_letter', {
  eventId: rawEvent, type: 'match.completed', attempts: 5,
  subjectKind: 'match', subjectId: rawMatch, correlationId,
  lastError: `POST ${secretUrl} authorization=${bearer}`,
});
logger.info('audit.recorded', {
  auditId: rawEvent, action: 'session.revoke', actorRole: 'support', actorId: rawAccount,
  subjectKind: 'session', subjectId: rawSubject, reasonCode: 'support_request', correlationId,
});

const serialized = JSON.stringify(lines);
for (const forbidden of [rawAccount, rawSubject, rawRoom, rawMatch, rawEvent,
  secretUrl, 'super-secret-route', bearer, 'platform-token-that-must-not-leak', email]) {
  check(!serialized.includes(forbidden), `central logger excludes raw ${forbidden === email ? 'personal data' : 'identifier/secret'}`,
    serialized);
}
check(lines.every((line) => line.event && line.service === 'platform'
  && line.correlationId === correlationId),
'auth, lobby, event, and audit records retain immutable service/event/correlation metadata');
check(lines.find((line) => line.event === 'outbox.dead_letter')?.attempts === 5
  && lines.find((line) => line.event === 'event.published')?.type === 'match.completed'
  && lines.find((line) => line.event === 'audit.recorded')?.reasonCode === 'support_request',
'closed operational classifications and retry data survive redaction');
check(lines.filter((line) => line.accountId).every((line) => /^sha256:[0-9a-f]{16}$/.test(line.accountId))
  && lines.find((line) => line.event === 'report.created')?.reporterAccountId
    === lines.find((line) => line.event === 'auth.verification.completed')?.accountId,
'raw identifiers become stable one-way pseudonyms for operational joins');

// Fields cannot overwrite the logger's own envelope. This was possible when `...fields` came
// last, and could relabel a warning as an attacker-chosen event/service.
logger.warn('alert.routed', {
  event: 'dependency.unavailable', service: 'match-server', level: 'debug',
  ts: email, correlationId,
});
const reserved = lines.at(-1);
check(reserved.event === 'alert.routed' && reserved.service === 'platform'
  && reserved.level === 'warn' && reserved.relatedEvent === 'dependency.unavailable'
  && reserved.sourceService === 'match-server' && reserved.ts !== email,
'caller fields cannot overwrite structured-log envelope identity');

// Drive the real observability caller with a secret-echoing transport error. Trace metadata and
// its closed attributes remain useful; arbitrary email/token/chat attributes and exception text
// do not reach the sink.
const obs = createObservability({ logger, alertWebhookUrl: secretUrl,
  fetchImpl: async (url) => { throw new Error(`fetch failed for ${url} with ${bearer}`); } });
const traceparent = traceparentForCorrelation(correlationId);
obs.recordSpan({ correlationId, traceparent, tier: 'client', name: 'client.action',
  attributes: { component: 'shell', status: 200, email, token: bearer, chat: email } });
await obs.alert({ key: 'secret-echo', severity: 'critical', event: 'dependency.unavailable',
  correlationId, component: 'database', errorCode: 'SERVICE_UNAVAILABLE' });
const afterObservability = JSON.stringify(lines);
const span = lines.find((line) => line.event === 'trace.span');
const delivery = lines.find((line) => line.event === 'alert.delivery_failed');
check(span?.tier === 'client' && span?.name === 'client.action'
  && span?.attributes?.component === 'shell' && span?.attributes?.status === 200
  && !('email' in span.attributes) && !('token' in span.attributes),
'real trace caller retains only closed operational span attributes');
check(delivery?.relatedEvent === 'dependency.unavailable'
  && delivery?.reason === 'transport' && delivery?.correlationId === correlationId
  && !afterObservability.includes(secretUrl) && !afterObservability.includes(bearer),
'real alert caller cannot leak a secret-bearing URL or echoed exception through the logger');

// Development mail used to rely on logging a token. The central boundary must remain safe even
// if a caller explicitly supplies credential-shaped fields, and an unsafe child binding cannot
// bypass it.
logger.info('mail.log_transport', { kind: 'verification', to: email,
  link: `${secretUrl}?token=${bearer}`, token: bearer, correlationId });
logger.child({ accountId: rawAccount, authorization: bearer }).error('mail.failed', {
  kind: 'recovery', message: `failed for ${email}`, correlationId,
});
logger.info('telemetry.record', {
  name: 'flow.step', version: 1, privacyClass: 'personal', retentionClass: 'standard',
  occurredAt: '2026-08-21T12:00:00.000Z', receivedAt: '2026-08-21T12:00:00.100Z',
  accountId: rawAccount, clientSessionId: rawSubject, correlationId,
  payload: { step: 'match', outcome: 'completed', errorCode: null,
    email, arbitraryPlayerText: `hello ${bearer}` },
});
const finalSerialized = JSON.stringify(lines);
check(!finalSerialized.includes(email) && !finalSerialized.includes(bearer)
  && !finalSerialized.includes(secretUrl),
'mail fields and child bindings cannot bypass the central privacy boundary');
const telemetry = lines.find((line) => line.event === 'telemetry.record');
check(telemetry?.name === 'flow.step' && telemetry?.privacyClass === 'personal'
  && telemetry?.payload?.step === 'match' && telemetry?.payload?.outcome === 'completed'
  && telemetry?.payload?.errorCode === null
  && /^sha256:[0-9a-f]{16}$/.test(telemetry?.accountId || '')
  && !('email' in telemetry.payload) && !('arbitraryPlayerText' in telemetry.payload),
'the telemetry log sink retains its closed KPI payload while pseudonymising linkage');

logger.info('metrics.labels_probe', {
  labels: {
    method: 'GET', status: '5xx', component: 'platform',
    token: 'abc123', password: 'password-shaped-value', email: 'email_without_at',
    ip: '203.0.113.9', clientIp: '198.51.100.7', address: 'private-host',
    url: 'https-secret-route', authorization: 'credential',
    customer: 'Alice', note: 'ordinary-looking-secret',
    arbitraryNested: { token: 'nested-secret', safe: 'not-a-scalar' },
  },
});
const labelProbe = lines.find((line) => line.event === 'metrics.labels_probe');
check(JSON.stringify(labelProbe?.labels) === JSON.stringify({
  method: 'GET', status: '5xx', component: 'platform',
}),
'nested labels deny token, password, email, IP, address, URL, authorization, and arbitrary objects',
JSON.stringify(labelProbe));
check(!JSON.stringify(lines).includes('abc123')
  && !JSON.stringify(lines).includes('password-shaped-value')
  && !JSON.stringify(lines).includes('email_without_at')
  && !JSON.stringify(lines).includes('203.0.113.9')
  && !JSON.stringify(lines).includes('198.51.100.7')
  && !JSON.stringify(lines).includes('private-host')
  && !JSON.stringify(lines).includes('https-secret-route')
  && !JSON.stringify(lines).includes('Alice')
  && !JSON.stringify(lines).includes('ordinary-looking-secret')
  && !JSON.stringify(lines).includes('nested-secret'),
'the closed label vocabulary rejects credential keys and non-denylisted personal dimensions');

if (failures) process.exit(1);
console.log('structured logger privacy checks passed');
