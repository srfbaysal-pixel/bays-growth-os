/** D6 — dry-run kota ayrımı ve tekil iş bazlı bounce oranı. Hiçbir test gerçek e-posta göndermez. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, closeTestPool, makeCtx, seedUsers } from './helpers.js';
import { upsertBusiness, recordEvidence, upsertContact } from '../src/discovery/pipeline.js';
import { getSector } from '../src/sectors/loader.js';
import { scoreBusiness } from '../src/scoring/score.js';
import { prepareDraftForBusiness } from '../src/outreach/drafts.js';
import { approveDraft } from '../src/outreach/approvals.js';
import { processSendQueue } from '../src/outreach/sender.js';
import { emailHealthSnapshot, evaluateKillSwitch } from '../src/outreach/killswitch.js';
import { isOutreachPaused, setOutreachPaused } from '../src/outreach/policy.js';
import type pg from 'pg';

let pool: pg.Pool;
let users: Awaited<ReturnType<typeof seedUsers>>;
beforeAll(async () => { pool = await freshDb(); users = await seedUsers(pool); });
afterAll(closeTestPool);

async function qualified(name: string, email: string) {
  const sector = (await getSector(pool, 'beauty'))!;
  const up = await upsertBusiness(pool, 'beauty', { source_key: 'mock', name, city: 'İstanbul', email });
  await upsertContact(pool, up.id, { email, source_key: 'mock', is_primary: true });
  for (const [f, v] of [['has_online_booking', false], ['has_instagram', true], ['has_public_email', true], ['has_phone', true]] as const) await recordEvidence(pool, up.id, 'mock', 'observation', f, v);
  await scoreBusiness(pool, sector, up.id);
  return { id: up.id, sector };
}
/** Tek işletme için N adet 'accepted' gönderim işi (SQL ile, sağlayıcı yok). */
async function seedAcceptedJobs(businessId: string, n: number, prefix: string) {
  await pool.query(
    `WITH d AS (
       INSERT INTO message_drafts(business_id, channel, subject, body, status, idempotency_key)
       SELECT $1, 'email', 's', 'b', 'sent', $2 || ':' || g FROM generate_series(1, $3) g RETURNING id),
     j AS (
       INSERT INTO send_jobs(draft_id, business_id, channel, to_address, status, reply_token, message_id, sent_at)
       SELECT id, $1, 'email', $2 || '-' || id || '@firma.example', 'accepted', $2 || '-' || id, '<' || id || '@test.invalid>', now() FROM d RETURNING id)
     INSERT INTO send_events(send_job_id, event) SELECT id, 'accepted' FROM j`,
    [businessId, prefix, n]
  );
  return (await pool.query(`SELECT id FROM send_jobs WHERE reply_token LIKE $1 || '-%' ORDER BY created_at`, [prefix])).rows.map((r) => r.id as string);
}

describe('D6 — dry-run kota ayrımı', () => {
  it('dry-run sağlayıcı kotasını tüketmez ve kota kaynaklı kill-switch üretmez; ardından gerçek gönderim kotayı 1\'den başlatır', async () => {
    await setOutreachPaused(pool, false, null, 'test'); await pool.query('DELETE FROM email_quota_usage');
    const dry = await makeCtx(pool, { EMAIL_DAILY_QUOTA: 1 as any, EMAIL_HOURLY_QUOTA: 1 as any });
    for (const [n, e] of [['Dry A', 'test@example.com'], ['Dry B', 'test@example.com']]) {
      const b = await qualified(n, e);
      const r = await prepareDraftForBusiness(pool, dry.cfg, dry.ai, b.sector, b.id);
      expect((await approveDraft(pool, dry.cfg, r.draft_id!, { id: users.owner.id })).outcome).toBe('queued');
    }
    const s = await processSendQueue(pool, dry.cfg, dry.email);
    expect(s.dry_run).toBe(2); expect(s.blocked).toBe(0); expect(s.paused).toBe(false);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM email_quota_usage WHERE provider = 'mock'`)).rows[0].n).toBe(0);
    expect((await evaluateKillSwitch(pool, dry.cfg)).paused).toBe(false);
    // Aynı sağlayıcı yapılandırması, gerçek-send mock: kota 1 → ilk gönderim geçer, ikincisi kota nedeniyle kuyruğa döner
    const live = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any, EMAIL_DAILY_QUOTA: 5 as any, EMAIL_HOURLY_QUOTA: 1 as any });
    for (const [n, e] of [['Live A', 'live-a@firma.example'], ['Live B', 'live-b@firma.example']]) {
      const b = await qualified(n, e);
      const r = await prepareDraftForBusiness(pool, live.cfg, live.ai, b.sector, b.id);
      await approveDraft(pool, live.cfg, r.draft_id!, { id: users.owner.id });
    }
    const s2 = await processSendQueue(pool, live.cfg, live.email);
    expect(s2.sent).toBe(1); expect(s2.blocked).toBe(1); expect(live.email.sent).toHaveLength(1);
    const q = (await pool.query(`SELECT sent_count FROM email_quota_usage WHERE provider = 'mock' AND bucket LIKE 'hour:%'`)).rows[0];
    expect(Number(q.sent_count)).toBe(2); // 1 başarılı + 1 reddedilen rezervasyon; dry-run'lar yok
  });
});

describe('D6 — tekil iş bazlı bounce oranı', () => {
  it('100 kabul edilen işten 5 bounce → %5; delivered ve yinelenen bounce oranı değiştirmez; 6. bounce eşiği aşar', async () => {
    await pool.query('DELETE FROM send_events'); await pool.query('DELETE FROM send_jobs'); await pool.query(`DELETE FROM message_drafts`); await pool.query('DELETE FROM inbound_messages');
    await setOutreachPaused(pool, false, null, 'test'); await pool.query('DELETE FROM email_quota_usage');
    const ctx = await makeCtx(pool, { EMAIL_MAX_BOUNCE_RATE: 0.05 as any, EMAIL_MAX_CONSECUTIVE_ERRORS: 99 as any });
    const b = await qualified('Oran Salon', 'oran@firma.example');
    const jobs = await seedAcceptedJobs(b.id, 100, 'rate');
    // 60 teslim bildirimi (accepted→delivered aynı mesaj, ikinci kez sayılmamalı)
    await pool.query(`INSERT INTO send_events(send_job_id, event) SELECT id, 'delivered' FROM send_jobs WHERE id = ANY($1)`, [jobs.slice(0, 60)]);
    // 5 işe bounce; 3'üne yinelenen bounce (webhook tekrarı) ve 1'ine ek complaint
    await pool.query(`INSERT INTO send_events(send_job_id, event) SELECT id, 'bounce' FROM send_jobs WHERE id = ANY($1)`, [jobs.slice(0, 5)]);
    await pool.query(`INSERT INTO send_events(send_job_id, event) SELECT id, 'bounce' FROM send_jobs WHERE id = ANY($1)`, [jobs.slice(0, 3)]);
    await pool.query(`INSERT INTO send_events(send_job_id, event) VALUES ($1, 'complaint')`, [jobs[0]]);
    let snap = await emailHealthSnapshot(pool, 'mock');
    expect(snap.sent24h).toBe(100); expect(snap.bounced24h).toBe(5); expect(snap.unmatchedBounces24h).toBe(0);
    expect(snap.bounceRate).toBeCloseTo(0.05, 6);
    expect((await evaluateKillSwitch(pool, ctx.cfg)).paused).toBe(false); // %5 eşiği aşmaz (> kuralı)
    // Eşleşmeyen bir DSN → paya eklenir → %6 → durur
    await pool.query(`INSERT INTO inbound_messages(channel, dedup_hash, from_address, body_text, classification, match_method) VALUES ('email','um1','MAILER-DAEMON@x','x','bounce','none')`);
    snap = await emailHealthSnapshot(pool, 'mock');
    expect(snap.unmatchedBounces24h).toBe(1); expect(snap.bounceRate).toBeCloseTo(0.06, 6);
    const k = await evaluateKillSwitch(pool, ctx.cfg);
    expect(k.paused).toBe(true); expect(k.reason).toMatch(/5 eşleşen \+ 1 eşleşmeyen \/ 100/);
    await setOutreachPaused(pool, false, null, 'test'); await pool.query('DELETE FROM inbound_messages');
    // 6. tekil bounce → %6 → durur; reject olayı da bounce ile eş değer
    await pool.query(`INSERT INTO send_events(send_job_id, event) VALUES ($1, 'reject')`, [jobs[5]]);
    snap = await emailHealthSnapshot(pool, 'mock'); expect(snap.bounced24h).toBe(6);
    expect((await evaluateKillSwitch(pool, ctx.cfg)).paused).toBe(true);
    expect((await isOutreachPaused(pool)).reason).toMatch(/Bounce oranı 6\.0%/);
  });
  it('örnek sayısı 10\'un altındayken oran değerlendirilmez; dry_run olayları paydaya girmez', async () => {
    await pool.query('DELETE FROM send_events'); await pool.query('DELETE FROM send_jobs'); await pool.query(`DELETE FROM message_drafts`);
    await setOutreachPaused(pool, false, null, 'test'); await pool.query('DELETE FROM email_quota_usage');
    const ctx = await makeCtx(pool, { EMAIL_MAX_BOUNCE_RATE: 0.05 as any, EMAIL_MAX_CONSECUTIVE_ERRORS: 99 as any });
    const b = (await pool.query(`SELECT id FROM businesses WHERE name = 'Oran Salon'`)).rows[0];
    const jobs = await seedAcceptedJobs(b.id, 9, 'small');
    await pool.query(`INSERT INTO send_events(send_job_id, event) VALUES ($1, 'bounce'), ($2, 'bounce')`, [jobs[0], jobs[1]]);
    const snap = await emailHealthSnapshot(pool, 'mock');
    expect(snap.sent24h).toBe(9); expect(snap.bounceRate).toBeGreaterThan(0.2);
    expect((await evaluateKillSwitch(pool, ctx.cfg)).paused).toBe(false);
    await pool.query(`UPDATE send_jobs SET status = 'dry_run' WHERE id = $1`, [jobs[8]]);
    await pool.query(`INSERT INTO send_events(send_job_id, event) SELECT id, 'dry_run' FROM send_jobs WHERE id = $1`, [jobs[8]]);
    expect((await emailHealthSnapshot(pool, 'mock')).sent24h).toBe(9);
  });
});
