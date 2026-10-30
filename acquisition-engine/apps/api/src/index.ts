import { getConfig } from './config.js';
import { buildContext } from './app.js';
import { buildServer } from './http/server.js';
import { runMigrations, assertDatabaseIdentity } from './db/migrate.js';
import { purgeExpiredSessions } from './auth/service.js';
import { log } from './lib/logger.js';

async function main() {
  const cfg = getConfig();
  const ctx = buildContext(cfg);
  await assertDatabaseIdentity(ctx.pool, cfg.EXPECTED_DB_NAME);
  if (process.env.AUTO_MIGRATE === 'true') { const done = await runMigrations(ctx.pool, undefined, cfg.EXPECTED_DB_NAME); if (done.length) log.info('migrations uygulandı', { done }); }
  const app = buildServer(ctx);
  await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
  log.info('API hazır', { host: cfg.API_HOST, port: cfg.API_PORT, dry_run: cfg.DRY_RUN, live: cfg.LIVE_OUTREACH_ENABLED, email: cfg.EMAIL_PROVIDER, ai: cfg.AI_PROVIDER, discovery: cfg.DISCOVERY_PROVIDER });
  const timer = setInterval(() => purgeExpiredSessions(ctx.pool).catch(() => undefined), 60 * 60 * 1000);
  const stop = async () => { clearInterval(timer); await app.close(); await ctx.pool.end(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
