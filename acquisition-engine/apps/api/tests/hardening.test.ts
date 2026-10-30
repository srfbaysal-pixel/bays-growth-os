/** Denetim düzeltmeleri: K1 (DB kimliği), K3 (dry_run ayrımı), K4 (bounce), Ö1 (iç uç ağ katmanı), Ö2 (SSRF), Ö8 (bildirim), K2/Ö9 (dağıtım dosyaları). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { freshDb, closeTestPool, makeCtx, seedUsers, testPool } from './helpers.js';
import { assertDatabaseIdentity, DatabaseIdentityError, runMigrations, resetDatabase } from '../src/db/migrate.js';
import { ipInCidr, isPrivateAddress, normalizeIp } from '../src/lib/ip.js';
import { assertSafeUrl, safeFetch, fetchWebsiteFacts, SsrfBlockedError } from '../src/discovery/website.js';
import { extractBounceInfo } from '../src/inbound/bounce.js';
import { processInbound } from '../src/inbound/process.js';
import { emailHealthSnapshot, evaluateKillSwitch } from '../src/outreach/killswitch.js';
import { notifyAdmin } from '../src/health/notify.js';
import { upsertBusiness, recordEvidence, upsertContact } from '../src/discovery/pipeline.js';
import { getSector } from '../src/sectors/loader.js';
import { scoreBusiness } from '../src/scoring/score.js';
import { prepareDraftForBusiness } from '../src/outreach/drafts.js';
import { approveDraft } from '../src/outreach/approvals.js';
import { processSendQueue } from '../src/outreach/sender.js';
import { runWf2Prepare } from '../src/workflows/wf2.js';
import { setOutreachPaused, isOutreachPaused } from '../src/outreach/policy.js';
import { buildServer } from '../src/http/server.js';
import { signRequest } from '../src/lib/crypto.js';
import type pg from 'pg';

let pool: pg.Pool;
let users: Awaited<ReturnType<typeof seedUsers>>;
beforeAll(async () => { pool = await freshDb(); users = await seedUsers(pool); });
afterAll(closeTestPool);

const ROOT = path.resolve(__dirname, '../../..');
const fakeDb = (name: string) => ({ query: (async () => ({ rows: [{ name, n: name, user: 'x' }] })) as any });

describe('K1 — veritabanı kimlik doğrulaması', () => {
  it('beklenen ad ile geçer, farklı ad ile durur', async () => {
    await expect(assertDatabaseIdentity(pool, 'bays_acq_test')).resolves.toBe('bays_acq_test');
    await expect(assertDatabaseIdentity(pool, 'bays_acq')).rejects.toBeInstanceOf(DatabaseIdentityError);
    await expect(runMigrations(pool, undefined, 'bays_acq')).rejects.toThrow(/beklenen "bays_acq"/);
    await expect(runMigrations(pool, undefined, 'bays_acq_test')).resolves.toEqual([]);
  });
  it('n8n veritabanında her durumda durur (beklenen ad eşleşse bile)', async () => {
    await expect(assertDatabaseIdentity(fakeDb('n8n'), 'n8n')).rejects.toThrow(/n8n/);
    await expect(assertDatabaseIdentity(fakeDb('prod_n8n_db'), 'prod_n8n_db')).rejects.toThrow(/n8n/);
    await expect(assertDatabaseIdentity(fakeDb(''), 'bays_acq')).rejects.toBeInstanceOf(DatabaseIdentityError);
    await expect(assertDatabaseIdentity(fakeDb('bays_acq'), 'bays_acq')).resolves.toBe('bays_acq');
  });
  it('resetDatabase yalnız test DB; n8n adı reddedilir', async () => {
    await expect(resetDatabase(fakeDb('n8n_test') as any)).rejects.toThrow(/n8n/);
    await expect(resetDatabase(fakeDb('bays_acq') as any)).rejects.toThrow(/test/);
  });
});

describe('Ö1 — IP/CIDR ve iç uç ağ katmanı', () => {
  it('CIDR eşleme IPv4/IPv6/mapped', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(ipInCidr('127.0.0.1', '127.0.0.0/8')).toBe(true);
    expect(ipInCidr('::1', '::1/128')).toBe(true);
    expect(ipInCidr('::ffff:192.168.1.5', '192.168.0.0/16')).toBe(true);
    expect(ipInCidr('fd12::1', 'fc00::/7')).toBe(true);
    expect(ipInCidr('2001:4860::8888', 'fc00::/7')).toBe(false);
    expect(ipInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
  it('özel adres tespiti', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1', '224.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '172.15.0.1', '172.32.0.1']) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress('garbage')).toBe(true);
  });
  it('/internal yalnız izinli ağdan; dış IP geçerli imzayla bile 403', async () => {
    const ctx = await makeCtx(pool);
    const app = buildServer(ctx); await app.ready();
    const body = JSON.stringify({ workflow_key: 'wf1_discovery', run_id: 'net-1', status: 'succeeded' });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'x-bays-timestamp': ts, 'x-bays-signature': signRequest(ctx.cfg.N8N_SHARED_SECRET, ts, body) };
    expect((await app.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers, remoteAddress: '8.8.8.8' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers, remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers, remoteAddress: '172.18.0.5' })).statusCode).toBe(200);
    // Sahte X-Forwarded-For dış IP'den gelirse yok sayılır (trustProxy yalnız loopback/özel ağ)
    expect((await app.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers: { ...headers, 'x-forwarded-for': '127.0.0.1' }, remoteAddress: '8.8.8.8' })).statusCode).toBe(403);
    // Özel ağdaki proxy (Caddy) dış istemci IP'sini iletirse ağ katmanı onu değerlendirir
    expect((await app.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers: { ...headers, 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '127.0.0.1' })).statusCode).toBe(403);
    // Özel liste: yalnız belirli adres
    const ctx2 = await makeCtx(pool, { INTERNAL_ALLOWED_IPS: '203.0.113.9/32' as any });
    const app2 = buildServer(ctx2); await app2.ready();
    expect((await app2.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers, remoteAddress: '127.0.0.1' })).statusCode).toBe(403);
    expect((await app2.inject({ method: 'POST', url: '/internal/heartbeat', payload: body, headers, remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    await app.close(); await app2.close();
  });
});

describe('Ö2 — SSRF koruması', () => {
  const lookupMap: Record<string, string[]> = { 'public.example': ['93.184.216.34'], 'evil.example': ['93.184.216.34', '10.0.0.5'], 'meta.example': ['169.254.169.254'], 'v6.example': ['::1'], 'mapped.example': ['::ffff:127.0.0.1'] };
  const lookup = async (h: string) => lookupMap[h] ?? [];
  it('şema, port, kullanıcı bilgisi, localhost ve özel DNS sonuçları reddedilir', async () => {
    await expect(assertSafeUrl('https://public.example/', lookup)).resolves.toBeInstanceOf(URL);
    for (const u of ['ftp://public.example/', 'https://public.example:4100/', 'https://user:pw@public.example/', 'http://localhost/', 'http://api.internal/', 'http://127.0.0.1/', 'http://[::1]/', 'http://evil.example/', 'http://meta.example/latest/meta-data', 'http://v6.example/', 'http://mapped.example/', 'http://0x7f000001/', 'http://unknown.example/']) {
      await expect(assertSafeUrl(u, lookup), u).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });
  it('yönlendirme ile özel ağa kaçış engellenir; her atlama doğrulanır', async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: any) => {
      const url = String(input); calls.push(url);
      if (url === 'https://public.example/') return new Response('', { status: 302, headers: { location: 'http://10.0.0.5/admin' } });
      if (url === 'https://public.example/a') return new Response('', { status: 301, headers: { location: '/b' } });
      if (url === 'https://public.example/b') return new Response('<html><title>ok</title></html>', { status: 200 });
      return new Response('x', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(safeFetch('https://public.example/', { fetchFn, lookup })).rejects.toThrow(/özel ağ/);
    expect(calls).toEqual(['https://public.example/']);
    const ok = await safeFetch('https://public.example/a', { fetchFn, lookup });
    expect(ok.status).toBe(200);
    expect(calls.slice(1)).toEqual(['https://public.example/a', 'https://public.example/b']);
    // Döngü: en fazla 3 yönlendirme
    const loopFetch = (async () => new Response('', { status: 302, headers: { location: 'https://public.example/loop' } })) as unknown as typeof fetch;
    await expect(safeFetch('https://public.example/loop', { fetchFn: loopFetch, lookup })).rejects.toThrow(/yönlendirme/);
  });
  it('fetchWebsiteFacts özel hedefte hiç istek atmaz ve nedeni kaydeder', async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return new Response('x'); }) as unknown as typeof fetch;
    const f = await fetchWebsiteFacts('http://evil.example', { timeoutMs: 1000, fetchFn, lookup });
    expect(f.fetched).toBe(false); expect(f.error).toMatch(/ssrf/); expect(called).toBe(0);
    const f2 = await fetchWebsiteFacts('https://192.168.1.1/', { timeoutMs: 1000, fetchFn, lookup });
    expect(f2.fetched).toBe(false); expect(called).toBe(0);
  });
});

describe('K4 — bounce/DSN işleme', () => {
  it('DSN alanlarından alıcı ve Message-ID çıkarır', () => {
    const info = extractBounceInfo(`Delivery Status Notification\nFinal-Recipient: rfc822; Yok@Firma.example\nOriginal-Recipient: rfc822;yok@firma.example\nAction: failed\nMessage-ID: <11111111-2222-4333-8444-555555555555@test.invalid>\nReply-To: reply+abc@test.invalid`, 'test.invalid');
    expect(info.recipients).toEqual(['yok@firma.example']);
    expect(info.messageIds).toEqual(['<11111111-2222-4333-8444-555555555555@test.invalid>']);
    expect(info.isDsn).toBe(true);
    const free = extractBounceInfo('The following address(es) failed:\n  kisi@site.example: unknown user\n', 'test.invalid');
    expect(free.recipients).toEqual(['kisi@site.example']);
    expect(extractBounceInfo('merhaba', 'test.invalid').recipients).toEqual([]);
  });
  it('In-Reply-To olmayan DSN, gövdedeki Message-ID ile işe eşleşir; eşleşmeyen DSN alıcıyı engeller; kill-switch sayar', async () => {
    const ctx = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any, EMAIL_DAILY_QUOTA: 100 as any, EMAIL_HOURLY_QUOTA: 100 as any });
    const sector = (await getSector(pool, 'beauty'))!;
    const up = await upsertBusiness(pool, 'beauty', { source_key: 'mock', name: 'DSN Salon', city: 'İstanbul', email: 'dsn@dsn.example' });
    await upsertContact(pool, up.id, { email: 'dsn@dsn.example', source_key: 'mock', is_primary: true });
    for (const [f, v] of [['has_online_booking', false], ['has_instagram', true], ['has_public_email', true], ['has_phone', true]] as const) await recordEvidence(pool, up.id, 'mock', 'observation', f, v);
    await scoreBusiness(pool, sector, up.id);
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, sector, up.id);
    await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
    await processSendQueue(pool, ctx.cfg, ctx.email);
    const job = (await pool.query('SELECT * FROM send_jobs WHERE business_id = $1', [up.id])).rows[0];
    expect(job.status).toBe('accepted');
    // 1) DSN From adresine gelir, In-Reply-To yok, gövdede Message-ID var
    const res = await processInbound(pool, ctx.ai, { from: 'MAILER-DAEMON@mx.example', to: 'iletisim@test.invalid', subject: 'Undeliverable: teklif', text: `Delivery Status Notification (Failure)\nFinal-Recipient: rfc822; dsn@dsn.example\nAction: failed\n\n--- Original message ---\nMessage-ID: ${job.message_id}\n`, provider_message_id: 'dsn-1' }, { replyDomain: ctx.cfg.EMAIL_REPLY_DOMAIN });
    expect(res.classification).toBe('bounce'); expect(res.matched).toBe(true); expect(res.match_method).toBe('bounce_message_id');
    expect((await pool.query('SELECT status FROM send_jobs WHERE id = $1', [job.id])).rows[0].status).toBe('bounced');
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE kind = 'email' AND value = 'dsn@dsn.example'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE value ILIKE '%mailer-daemon%'`)).rowCount).toBe(0);
    // 2) Sadece alıcı adresiyle (Message-ID yok) eşleşme
    await pool.query(`UPDATE send_jobs SET status = 'accepted' WHERE id = $1`, [job.id]);
    const res2 = await processInbound(pool, ctx.ai, { from: 'postmaster@mx.example', subject: 'Mail delivery failed', text: 'The following address(es) failed:\n  dsn@dsn.example: user unknown\n', provider_message_id: 'dsn-2' }, { replyDomain: ctx.cfg.EMAIL_REPLY_DOMAIN });
    expect(res2.match_method).toBe('bounce_recipient');
    // 3) Hiç eşleşmeyen DSN: alıcı engellenir, inceleme görevi açılır, gönderen engellenmez
    const res3 = await processInbound(pool, ctx.ai, { from: 'MAILER-DAEMON@mx.example', subject: 'Mail delivery failed', text: 'Final-Recipient: rfc822; bilinmeyen@baska.example\nAction: failed', provider_message_id: 'dsn-3' }, { replyDomain: ctx.cfg.EMAIL_REPLY_DOMAIN });
    expect(res3.matched).toBe(false); expect(res3.classification).toBe('bounce');
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE kind = 'email' AND value = 'bilinmeyen@baska.example'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM tasks WHERE title LIKE 'Eşleşmeyen bounce:%'`)).rowCount).toBe(1);
    const snap = await emailHealthSnapshot(pool, 'mock');
    expect(snap.unmatchedBounces24h).toBe(1);
    expect(snap.bounced24h).toBeGreaterThanOrEqual(3);
  });
});

describe('K3 — DRY_RUN gerçek gönderimden ayrı', () => {
  it('dry_run taslak/iş durumu ayrı; işletme durumu değişmez; sonradan gerçek taslak hazırlanabilir', async () => {
    await pool.query('DELETE FROM email_quota_usage'); await setOutreachPaused(pool, false, null, 'test');
    const ctx = await makeCtx(pool);
    const sector = (await getSector(pool, 'beauty'))!;
    const up = await upsertBusiness(pool, 'beauty', { source_key: 'mock', name: 'Dry Ayrım Salon', city: 'İzmir', email: 'test@example.com' });
    await upsertContact(pool, up.id, { email: 'test@example.com', source_key: 'mock', is_primary: true });
    for (const [f, v] of [['has_online_booking', false], ['has_instagram', true], ['has_public_email', true], ['has_phone', true]] as const) await recordEvidence(pool, up.id, 'mock', 'observation', f, v);
    await scoreBusiness(pool, sector, up.id);
    const r1 = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, sector, up.id);
    expect((await approveDraft(pool, ctx.cfg, r1.draft_id!, { id: users.owner.id })).outcome).toBe('queued');
    const s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.dry_run).toBe(1); expect(ctx.email.sent).toHaveLength(0);
    const d1 = (await pool.query('SELECT status FROM message_drafts WHERE id = $1', [r1.draft_id])).rows[0];
    expect(d1.status).toBe('dry_run');
    const j1 = (await pool.query('SELECT status, provider, sent_at, provider_message_id FROM send_jobs WHERE draft_id = $1', [r1.draft_id])).rows[0];
    expect(j1).toMatchObject({ status: 'dry_run', provider: 'dry_run', sent_at: null, provider_message_id: null });
    expect((await pool.query('SELECT status FROM businesses WHERE id = $1', [up.id])).rows[0].status).toBe('qualified');
    // Gerçek taslak: WF2 adayı olmaya devam eder ve yeni sıra numarasıyla hazırlanır
    const p = await runWf2Prepare(pool, ctx.cfg, ctx.ai, { runId: 'k3-wf2', sectorKey: 'beauty' });
    const r2 = (await pool.query(`SELECT id, status, idempotency_key FROM message_drafts WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`, [up.id])).rows[0];
    expect(p.prepared).toBeGreaterThanOrEqual(1);
    expect(r2.id).not.toBe(r1.draft_id); expect(r2.status).toBe('pending_approval'); expect(r2.idempotency_key).toBe(`${up.id}:email:2`);
    // Etkin taslak varken tekrar hazırlama idempotent
    const r3 = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, sector, up.id);
    expect(r3.draft_id).toBe(r2.id); expect(r3.skipped).toMatch(/idempotent/);
    // Metrikte dry_run 'sent' sayılmaz
    const sent = Number((await pool.query(`SELECT COUNT(*) n FROM send_events WHERE event = 'accepted' AND send_job_id IN (SELECT id FROM send_jobs WHERE business_id = $1)`, [up.id])).rows[0].n);
    expect(sent).toBe(0);
  });
});

describe('Ö8 — kill-switch bildirimi', () => {
  it('durum değişiminde görev + audit + imzalı webhook; tekrar değerlendirmede tek bildirim', async () => {
    await pool.query('DELETE FROM send_events'); await pool.query('DELETE FROM email_quota_usage'); await setOutreachPaused(pool, false, null, 'test');
    await pool.query(`DELETE FROM tasks WHERE dedup_key LIKE 'alert:%'`);
    const posted: any[] = [];
    const fetchFn = (async (url: any, init: any) => { posted.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const ctx = await makeCtx(pool, { ALERT_WEBHOOK_URL: 'https://n8n.example/webhook/bays-alert', EMAIL_DAILY_QUOTA: 0 as any });
    await pool.query(`INSERT INTO email_quota_usage(bucket, provider, sent_count) VALUES ('day:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'), 'mock', 1)`);
    const k1 = await evaluateKillSwitch(pool, ctx.cfg, { fetchFn });
    expect(k1.paused).toBe(true);
    const k2 = await evaluateKillSwitch(pool, ctx.cfg, { fetchFn });
    expect(k2.paused).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.kind).toBe('kill_switch');
    expect(posted[0].headers['x-bays-signature']).toMatch(/^sha256=/);
    expect(signRequest(ctx.cfg.N8N_SHARED_SECRET, posted[0].headers['x-bays-timestamp'], JSON.stringify(posted[0].body))).toBe(posted[0].headers['x-bays-signature']);
    expect((await pool.query(`SELECT 1 FROM tasks WHERE status = 'open' AND title LIKE '[UYARI] Gönderim otomatik%'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'alert_kill_switch'`)).rowCount).toBe(1);
    expect((await isOutreachPaused(pool)).reason).toMatch(/kota/i);
    // Webhook yoksa veya hata verirse akış durmaz
    const ctxNo = await makeCtx(pool);
    expect((await notifyAdmin(pool, ctxNo.cfg, { kind: 'other', title: 'x', body: 'y' })).webhook).toBe('skipped');
    const failing = (async () => { throw new Error('ağ yok'); }) as unknown as typeof fetch;
    expect((await notifyAdmin(pool, ctx.cfg, { kind: 'other', title: 'z', body: 'y' }, failing)).webhook).toBe('failed');
  });
});

describe('K2/Ö9/Ö1 — dağıtım dosyaları', () => {
  it('.dockerignore gerekli girdileri içerir', () => {
    const di = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
    for (const e of ['**/node_modules', '**/.next', '.env', '!.env.example', '**/test-results', '.git']) expect(di).toContain(e);
  });
  it('compose: log rotasyonu her serviste, portlar yalnız loopback, bellek limitleri', () => {
    const c = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    expect(c).toMatch(/max-size: "10m"/); expect(c).toMatch(/max-file: "3"/);
    expect((c.match(/logging: \*default-logging/g) ?? []).length).toBe(3);
    expect(c).not.toMatch(/"0\.0\.0\.0:\d+:\d+"/); expect(c).toMatch(/127\.0\.0\.1:4100:4100/); expect(c).toMatch(/127\.0\.0\.1:4200:4200/);
    expect((c.match(/memory: 256M/g) ?? []).length).toBe(3);
    expect(c).toMatch(/INTERNAL_ALLOWED_IPS/);
  });
  it('Caddy: /internal yalnız özel ağ, diğerleri 403; /api ve /webhooks API\'ye', () => {
    const caddy = readFileSync(path.join(ROOT, 'deploy/Caddyfile.snippet'), 'utf8');
    expect(caddy).toMatch(/remote_ip private_ranges/); expect(caddy).toMatch(/respond "forbidden" 403/);
    expect(caddy).toMatch(/handle \/api\/\*/); expect(caddy).toMatch(/handle \/webhooks\/\*/);
  });
  it('preflight ve build betikleri bellek/swap kontrolü yapar', () => {
    expect(readFileSync(path.join(ROOT, 'deploy/scripts/preflight.sh'), 'utf8')).toMatch(/swap/i);
    const b = readFileSync(path.join(ROOT, 'deploy/scripts/build-images.sh'), 'utf8');
    expect(b).toMatch(/check_mem/); expect(b).toMatch(/docker save/);
  });
});
