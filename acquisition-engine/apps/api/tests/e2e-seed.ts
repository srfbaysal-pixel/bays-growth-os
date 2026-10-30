/** Playwright e2e için: test veritabanını sıfırlar, sektör/katalog/kullanıcı yükler, WF1 (mock) + WF2 hazırlık çalıştırır. */
import { freshDb, closeTestPool, makeCtx, seedUsers, mockWebsiteFetch } from './helpers.js';
import { runWf1 } from '../src/workflows/wf1.js';
import { runWf2Prepare } from '../src/workflows/wf2.js';
import { runWf3Metrics } from '../src/workflows/wf3.js';

const pool = await freshDb();
await seedUsers(pool);
const ctx = await makeCtx(pool);
ctx.fetchFn = await mockWebsiteFetch();
for (const [sector, city] of [['education', 'İstanbul'], ['beauty', 'İstanbul'], ['beauty', 'İzmir'], ['clinic', 'İstanbul'], ['clinic', 'Ankara']]) {
  await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, fetchFn: ctx.fetchFn }, { sectorKey: sector, city, runId: `e2e-wf1-${sector}-${city}` });
}
const p = await runWf2Prepare(pool, ctx.cfg, ctx.ai, { runId: 'e2e-wf2' });
await runWf3Metrics(pool, { runId: 'e2e-wf3' });
console.log(JSON.stringify({ seeded: true, drafts: p.prepared }));
await closeTestPool();
