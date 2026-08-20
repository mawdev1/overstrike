/**
 * Platform entry point.
 *
 * Run:  node platform/src/index.js
 *
 * Fails fast on bad configuration (config.js), binds, and installs a shutdown that drains
 * rather than severs — an in-flight result submission that dies mid-write is exactly the
 * partial state the outbox exists to prevent.
 */
import { loadConfig } from './core/config.js';
import { buildApp } from './app.js';

// Backstop. Every request path is already wrapped (core/http.js), but a bug anywhere else
// must not take the process down silently — log it, then exit deliberately so the
// orchestrator restarts a process we know is compromised rather than one we do not.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ level: 'error', event: 'unhandledRejection', reason: String(reason && reason.stack || reason) }));
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ level: 'error', event: 'uncaughtException', reason: String(err && err.stack || err) }));
  process.exit(1);
});

const config = loadConfig();
const { server, deps, stop } = await buildApp(config);

server.listen(config.port, () => {
  deps.logger.info('platform.listening', { port: config.port, env: config.env, storage: config.storage });
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info('platform.shutdown', { signal });
    // Stop accepting, let in-flight requests finish, then release the store.
    server.close(async () => {
      stop();
      try { await deps.store.close(); } catch (err) { deps.logger.error('store.close.failed', { err: String(err) }); }
      process.exit(0);
    });
    // A drain that never completes is a deploy that never completes.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
