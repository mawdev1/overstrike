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

const config = loadConfig();
const { server, deps } = await buildApp(config);

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
      try { await deps.store.close(); } catch (err) { deps.logger.error('store.close.failed', { err: String(err) }); }
      process.exit(0);
    });
    // A drain that never completes is a deploy that never completes.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
