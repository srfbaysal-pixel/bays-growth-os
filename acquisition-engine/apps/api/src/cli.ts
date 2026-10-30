import { readFile } from 'node:fs/promises';
import { getConfig } from './config.js';
import { buildContext } from './app.js';
import { runMigrations } from './db/migrate.js';
import { loadSectorFiles, upsertSectors, getSector } from './sectors/loader.js';
import { loadServiceCatalog, upsertServices } from './catalog/services.js';
import { createUser } from './auth/service.js';
import { runEmailPreflight } from './email/preflight.js';
import { runWf1 } from './workflows/wf1.js';
import { runWf2Prepare, runWf2Send } from './workflows/wf2.js';
import { runWf3Metrics } from './workflows/wf3.js';
import { csvToBusinesses } from './discovery/csv.js';
import { recordDiscoveryObservations, upsertBusiness, upsertContact } from './discovery/pipeline.js';
import { scoreBusiness } from './scoring/score.js';
import { randomToken } from './lib/crypto.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const cfg = getConfig();
  const ctx = buildContext(cfg);
  try {
    switch (cmd) {
      case 'migrate': { const done = await runMigrations(ctx.pool); console.log(done.length ? `Uygulandı: ${done.join(', ')}` : 'Şema güncel'); break; }
      case 'seed': {
        await runMigrations(ctx.pool);
        await upsertSectors(ctx.pool, await loadSectorFiles());
        await upsertServices(ctx.pool, await loadServiceCatalog());
        if (cfg.ADMIN_EMAIL && cfg.ADMIN_PASSWORD) { await createUser(ctx.pool, { email: cfg.ADMIN_EMAIL, password: cfg.ADMIN_PASSWORD, role: 'owner' }); console.log(`Yönetici: ${cfg.ADMIN_EMAIL}`); }
        else console.log('ADMIN_EMAIL/ADMIN_PASSWORD verilmedi; kullanıcı oluşturulmadı (create-user komutunu kullanın)');
        console.log('Sektörler ve hizmet kataloğu yüklendi. Fiyat planları YER TUTUCU (0); panelden girin.');
        break;
      }
      case 'create-user': {
        const email = flag('email'); const password = flag('password'); const role = (flag('role') ?? 'operator') as any;
        if (!email || !password) throw new Error('--email ve --password gerekli');
        const u = await createUser(ctx.pool, { email, password, role });
        console.log(`Kullanıcı: ${u.email} (${u.role})`); break;
      }
      case 'email-preflight': {
        const checks = await runEmailPreflight(cfg);
        for (const c of checks) console.log(`${c.ok === true ? 'OK  ' : c.ok === false ? 'FAIL' : '?   '} ${c.name}: ${c.detail}`);
        const v = await ctx.email.verify().catch((e) => ({ ok: false, detail: (e as Error).message }));
        console.log(`${v.ok ? 'OK  ' : 'FAIL'} provider.verify: ${v.detail}`);
        if (checks.some((c) => c.ok === false) || !v.ok) process.exitCode = 2;
        break;
      }
      case 'wf1': {
        const sector = flag('sector'); const city = flag('city') ?? 'İstanbul';
        if (!sector) throw new Error('--sector gerekli');
        console.log(JSON.stringify(await runWf1(ctx.pool, cfg, { discovery: ctx.discovery, ai: ctx.ai }, { sectorKey: sector, city, limitPerQuery: Number(flag('limit') ?? 20), targetQualified: Number(flag('target') ?? 30), runId: `cli-wf1-${randomToken(6)}` }), null, 2));
        break;
      }
      case 'wf2-prepare': console.log(JSON.stringify(await runWf2Prepare(ctx.pool, cfg, ctx.ai, { runId: `cli-wf2p-${randomToken(6)}`, limit: Number(flag('limit') ?? 20), sectorKey: flag('sector') ?? null }), null, 2)); break;
      case 'wf2-send': console.log(JSON.stringify(await runWf2Send(ctx.pool, cfg, ctx.email, { runId: `cli-wf2s-${randomToken(6)}`, limit: Number(flag('limit') ?? 10) }), null, 2)); break;
      case 'wf3-metrics': console.log(JSON.stringify(await runWf3Metrics(ctx.pool, { runId: `cli-wf3m-${randomToken(6)}`, day: flag('day'), weekly: args.includes('--weekly') }), null, 2)); break;
      case 'import-csv': {
        const file = flag('file'); const sectorKey = flag('sector');
        if (!file || !sectorKey) throw new Error('--file ve --sector gerekli');
        const sector = await getSector(ctx.pool, sectorKey);
        if (!sector) throw new Error('Sektör yok');
        let created = 0, merged = 0;
        for (const b of csvToBusinesses(await readFile(file, 'utf8'))) {
          const up = await upsertBusiness(ctx.pool, sector.key, b); up.created ? created++ : merged++;
          await recordDiscoveryObservations(ctx.pool, up.id, b);
          if (b.email) await upsertContact(ctx.pool, up.id, { email: b.email, source_key: 'csv_import', is_primary: true });
          await scoreBusiness(ctx.pool, sector, up.id);
        }
        console.log(`Oluşturulan: ${created}, birleştirilen: ${merged}`); break;
      }
      default:
        console.log('Komutlar: migrate | seed | create-user --email --password [--role] | email-preflight | wf1 --sector --city [--limit --target] | wf2-prepare [--limit --sector] | wf2-send [--limit] | wf3-metrics [--day --weekly] | import-csv --file --sector');
    }
  } finally { await ctx.pool.end(); }
}
main().catch((e) => { console.error('Hata:', e.message); process.exit(1); });
