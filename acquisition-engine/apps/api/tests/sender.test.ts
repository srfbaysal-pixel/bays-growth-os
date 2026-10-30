import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { freshDb, closeTestPool, makeCtx, seedUsers } from './helpers.js';
import { upsertBusiness, recordEvidence, upsertContact } from '../src/discovery/pipeline.js';
import { getSector } from '../src/sectors/loader.js';
import { scoreBusiness } from '../src/scoring/score.js';
import { prepareDraftForBusiness } from '../src/outreach/drafts.js';
import { approveDraft, rejectDraft, editDraft } from '../src/outreach/approvals.js';
import { processSendQueue, recordDeliveryEvent } from '../src/outreach/sender.js';
import { suppressBusinessEverywhere, isOutreachPaused, setOutreachPaused } from '../src/outreach/policy.js';
import type pg from 'pg';

let pool: pg.Pool;
let users: Awaited<ReturnType<typeof seedUsers>>;
beforeAll(async () => { pool = await freshDb(); users = await seedUsers(pool); });
afterAll(closeTestPool);

async function qualifiedBusiness(name: string, email: string) {
  const sector = (await getSector(pool, 'beauty'))!;
  const up = await upsertBusiness(pool, 'beauty', { source_key: 'mock', name, city: 'İstanbul', email });
  await upsertContact(pool, up.id, { email, source_key: 'mock', is_primary: true });
  for (const [f, v] of [['has_online_booking', false], ['has_instagram', true], ['has_public_email', true], ['has_phone', true], ['has_whatsapp_link', false]] as const) await recordEvidence(pool, up.id, 'mock', 'observation', f, v);
  await scoreBusiness(pool, sector, up.id);
  return { id: up.id, sector };
}

describe('onay ve gönderim güvenliği', () => {
  beforeEach(async () => { await setOutreachPaused(pool, false, null, 'test'); await pool.query('DELETE FROM email_quota_usage'); });

  it('onaysız taslak asla gönderilmez', async () => {
    const ctx = await makeCtx(pool);
    const b = await qualifiedBusiness('Onaysız Salon', 'test@example.com');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    expect(r.status).toBe('pending_approval');
    const stats = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(stats.picked).toBe(0);
    expect(ctx.email.sent).toHaveLength(0);
    expect(Number((await pool.query('SELECT COUNT(*) n FROM send_jobs')).rows[0].n)).toBe(0);
  });

  it('reddedilen taslak kuyruğa girmez; düzenleme doğrulanır', async () => {
    const ctx = await makeCtx(pool);
    const b = await qualifiedBusiness('Ret Salon', 'ret@firma.example');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    await expect(editDraft(pool, r.draft_id!, { id: users.operator.id }, { body: 'Merhaba Yanlış Firma, hayır' })).rejects.toThrow(/doğrulama/);
    await editDraft(pool, r.draft_id!, { id: users.operator.id }, { body: 'Merhaba Ret Salon ekibi, kısa bir görüşme ister misiniz? İlgilenmiyorsanız hayır yazmanız yeterli.' });
    await rejectDraft(pool, r.draft_id!, { id: users.operator.id }, 'uygun değil');
    await expect(approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.operator.id })).rejects.toThrow(/onaylanamaz/);
    expect(Number((await pool.query('SELECT COUNT(*) n FROM send_jobs')).rows[0].n)).toBe(0);
    const v = (await pool.query('SELECT version FROM message_drafts WHERE id = $1', [r.draft_id])).rows[0];
    expect(v.version).toBe(2);
  });

  it('test modu + gerçek alıcı → manuel görev, gönderim yok', async () => {
    const ctx = await makeCtx(pool);
    const b = await qualifiedBusiness('Gerçek Salon', 'gercek@firma.example');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    const out = await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
    expect(out.outcome).toBe('manual_task');
    const t = await pool.query(`SELECT * FROM tasks WHERE draft_id = $1 AND kind = 'manual_outreach'`, [r.draft_id]);
    expect(t.rowCount).toBe(1);
    expect(t.rows[0].description).toContain('Gerçek Salon');
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('DRY_RUN: onaylı test alıcısı kuyruğa girer, sağlayıcıya gitmez, dry_run olayı yazılır', async () => {
    const ctx = await makeCtx(pool);
    const b = await qualifiedBusiness('Dry Salon', 'test@example.com');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    const out = await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
    expect(out.outcome).toBe('queued');
    const stats = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(stats.dry_run).toBe(1);
    expect(ctx.email.sent).toHaveLength(0);
    const job = (await pool.query('SELECT * FROM send_jobs WHERE draft_id = $1', [r.draft_id])).rows[0];
    expect(job.status).toBe('dry_run');
    expect(job.message_id).toMatch(/@test\.invalid>$/);
    const ev = (await pool.query('SELECT event FROM send_events WHERE send_job_id = $1 ORDER BY occurred_at', [job.id])).rows.map((e) => e.event);
    expect(ev).toEqual(['queued', 'attempt', 'dry_run']);
  });

  it('canlı mod (uyumlu): tek gönderim; hata → retry; tekrar çalıştırmada mükerrer gönderim yok', async () => {
    const ctx = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any });
    const b = await qualifiedBusiness('Canlı Salon', 'canli@firma.example');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    expect((await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id })).outcome).toBe('queued');
    ctx.email.failNext = 1;
    let s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.retried).toBe(1);
    expect(ctx.email.sent).toHaveLength(0);
    let job = (await pool.query('SELECT * FROM send_jobs WHERE draft_id = $1', [r.draft_id])).rows[0];
    expect(job.status).toBe('queued'); expect(job.attempts).toBe(1);
    expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    // bekleme süresi dolmadan tekrar çalıştır → alınmaz
    s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.picked).toBe(0);
    await pool.query('UPDATE send_jobs SET next_attempt_at = now() WHERE id = $1', [job.id]);
    s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.sent).toBe(1);
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0].replyTo).toMatch(/^reply\+[A-Za-z0-9_-]+@test\.invalid$/);
    expect(ctx.email.sent[0].idempotencyKey).toBe(job.id);
    // Tekrar çalıştır → ikinci gönderim yok
    s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.picked).toBe(0);
    expect(ctx.email.sent).toHaveLength(1);
    job = (await pool.query('SELECT * FROM send_jobs WHERE draft_id = $1', [r.draft_id])).rows[0];
    expect(job.status).toBe('accepted');
    expect((await pool.query('SELECT status FROM businesses WHERE id = $1', [b.id])).rows[0].status).toBe('contacted');
    // Teslimat ve bounce olayları
    const d1 = await recordDeliveryEvent(pool, { providerMessageId: job.provider_message_id, event: 'delivered', providerEventId: 'ev-1' });
    expect(d1.matched).toBe(true);
    const d2 = await recordDeliveryEvent(pool, { providerMessageId: job.provider_message_id, event: 'delivered', providerEventId: 'ev-1' });
    expect(d2.matched).toBe(true);
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM send_events WHERE send_job_id = $1 AND event = 'delivered'`, [job.id])).rows[0].n)).toBe(1);
    await recordDeliveryEvent(pool, { messageId: job.message_id, event: 'bounce', providerEventId: 'ev-2' });
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE kind = 'email' AND value = 'canli@firma.example'`)).rowCount).toBe(1);
  });

  it('ardışık hatalar kill-switch ile gönderimi durdurur', async () => {
    const ctx = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any, EMAIL_MAX_CONSECUTIVE_ERRORS: 2 as any });
    await pool.query('DELETE FROM send_events'); await pool.query('DELETE FROM send_jobs'); await pool.query(`UPDATE message_drafts SET status = 'cancelled'`);
    const b = await qualifiedBusiness('Hata Salon', 'hata@firma.example');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
    ctx.email.failNext = 5;
    await processSendQueue(pool, ctx.cfg, ctx.email);
    await pool.query('UPDATE send_jobs SET next_attempt_at = now()');
    const s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.paused).toBe(true);
    expect((await isOutreachPaused(pool)).reason).toMatch(/Ardışık/);
    const s2 = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s2.paused).toBe(true); expect(s2.picked).toBe(0);
  });

  it('maksimum denemeden sonra failed; kota aşımında kuyruğa geri', async () => {
    const ctx = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any, EMAIL_MAX_CONSECUTIVE_ERRORS: 99 as any, EMAIL_HOURLY_QUOTA: 1 as any });
    await pool.query('DELETE FROM send_events'); await pool.query('DELETE FROM send_jobs'); await pool.query(`UPDATE message_drafts SET status = 'cancelled'`);
    const b = await qualifiedBusiness('Fail Salon', 'fail@firma.example');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
    ctx.email.failNext = 10;
    for (let i = 0; i < 3; i++) { await pool.query('UPDATE send_jobs SET next_attempt_at = now()'); await pool.query('DELETE FROM email_quota_usage'); await processSendQueue(pool, ctx.cfg, ctx.email); }
    const job = (await pool.query('SELECT status, attempts FROM send_jobs WHERE draft_id = $1', [r.draft_id])).rows[0];
    expect(job.status).toBe('failed'); expect(job.attempts).toBe(3);
    // Kota: saatlik 1 → ikinci iş kuyruğa geri döner
    await pool.query('DELETE FROM email_quota_usage');
    const b2 = await qualifiedBusiness('Kota A', 'kota-a@firma.example');
    const b3 = await qualifiedBusiness('Kota B', 'kota-b@firma.example');
    for (const x of [b2, b3]) { const rr = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, x.sector, x.id); await approveDraft(pool, ctx.cfg, rr.draft_id!, { id: users.owner.id }); }
    ctx.email.failNext = 0;
    const s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.sent).toBe(1); expect(s.blocked).toBe(1);
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM send_jobs WHERE status = 'queued'`)).rows[0].n)).toBe(1);
  });

  it('onaydan sonra ret listesine giren işletmeye gönderim yapılmaz', async () => {
    const ctx = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any, EMAIL_MAX_CONSECUTIVE_ERRORS: 99 as any });
    await pool.query('DELETE FROM send_events'); await pool.query('DELETE FROM send_jobs'); await pool.query(`UPDATE message_drafts SET status = 'cancelled'`);
    const b = await qualifiedBusiness('Sonradan Ret', 'sonra@firma.example');
    const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id);
    await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
    await pool.query(`INSERT INTO suppressions(kind, value, reason) VALUES ('email', 'sonra@firma.example', 'test')`);
    const s = await processSendQueue(pool, ctx.cfg, ctx.email);
    expect(s.blocked).toBe(1); expect(ctx.email.sent).toHaveLength(0);
    // Tüm kanallarda engelleme
    await suppressBusinessEverywhere(pool, b.id, 'ret', 'manual');
    const sup = await pool.query(`SELECT kind FROM suppressions WHERE value IN ($1, 'sonra@firma.example')`, [b.id]);
    expect(sup.rows.map((x) => x.kind).sort()).toEqual(['business', 'email']);
    const perms = await pool.query(`SELECT channel, status FROM channel_permissions WHERE business_id = $1`, [b.id]);
    expect(perms.rows.every((p) => p.status === 'opt_out')).toBe(true);
    expect(perms.rows.length).toBe(5);
    expect(await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, b.sector, b.id).then((x) => x.skipped)).toMatch(/Durum uygun değil/);
  });
});
