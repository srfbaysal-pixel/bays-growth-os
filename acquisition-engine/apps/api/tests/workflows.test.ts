import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, closeTestPool, makeCtx, seedUsers } from './helpers.js';
import { runWf1 } from '../src/workflows/wf1.js';
import { runWf2Prepare, runWf2Send } from '../src/workflows/wf2.js';
import { runWf3Metrics, runWf3Inbound } from '../src/workflows/wf3.js';
import { approveDraft } from '../src/outreach/approvals.js';
import { createQuote, setQuoteStatus } from '../src/sales/quotes.js';
import { createReferralCampaign, updateReferralCampaign } from '../src/sales/referral.js';
import { runEmailPreflight } from '../src/email/preflight.js';
import type pg from 'pg';

let pool: pg.Pool;
let users: Awaited<ReturnType<typeof seedUsers>>;
beforeAll(async () => { pool = await freshDb(); users = await seedUsers(pool); });
afterAll(closeTestPool);

describe('WF1 keşif', () => {
  it('mock kaynaktan keşif, web sitesi gözlemi, çıkarım ve puanlama; mükerrerler birleşir', async () => {
    const ctx = await makeCtx(pool);
    const s = await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'education', city: 'İstanbul', runId: 'wf1-test-1' });
    expect(s.found).toBeGreaterThan(0);
    expect(s.created).toBe(2); // Mavi Dil + Zirve (Mavi Dil Ltd. Şti. birleşir)
    expect(s.merged).toBe(0);
    expect(s.websites_fetched).toBe(2);
    expect(s.errors).toEqual([]);
    const ev = await pool.query(`SELECT b.name, e.kind, e.field, e.value FROM research_evidence e JOIN businesses b ON b.id = e.business_id ORDER BY b.name, e.kind, e.field`);
    const zirve = ev.rows.filter((r) => r.name.startsWith('Zirve'));
    expect(zirve.find((r) => r.field === 'has_whatsapp_link' && r.kind === 'observation')?.value).toBe(true);
    expect(zirve.find((r) => r.field === 'has_online_booking' && r.kind === 'observation')?.value).toBe(true);
    expect(zirve.find((r) => r.field === 'multi_branch' && r.kind === 'inference')?.value).toBe(true);
    expect(zirve.some((r) => r.kind === 'inference' && r.field === 'has_whatsapp_link')).toBe(false);
    const contact = await pool.query(`SELECT c.email_normalized FROM contacts c JOIN businesses b ON b.id = c.business_id WHERE b.name LIKE 'Zirve%'`);
    expect(contact.rows[0]?.email_normalized).toBe('kayit@zirvekurs.example');
    const run = (await pool.query(`SELECT status, stats FROM workflow_runs WHERE run_id = 'wf1-test-1'`)).rows[0];
    expect(run.status).toBe('succeeded');
    // Tekrar çalıştırma: yeni kayıt oluşmaz
    const s2 = await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'education', city: 'İstanbul', runId: 'wf1-test-2' });
    expect(s2.created).toBe(0);
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM businesses WHERE sector_key = 'education'`)).rows[0].n)).toBe(2);
  });
  it('klinikte hariç tutma çalışır; kaynak hatası partial durum üretir', async () => {
    const ctx = await makeCtx(pool);
    const s = await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'clinic', city: 'Ankara', runId: 'wf1-clinic' });
    expect(s.excluded).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT 1 FROM businesses WHERE name LIKE '%Devlet Hastanesi%'`)).rowCount).toBe(0);
    const failing = { key: 'fail', search: async () => { throw new Error('API down'); } };
    const f = await runWf1(pool, ctx.cfg, { discovery: failing, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'beauty', city: 'İzmir', runId: 'wf1-fail' });
    expect(f.errors.length).toBeGreaterThan(0);
    expect((await pool.query(`SELECT status FROM workflow_runs WHERE run_id = 'wf1-fail'`)).rows[0].status).toBe('partial');
    const bad = await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai }, { sectorKey: 'yok', city: 'x', runId: 'wf1-bad' });
    expect((await pool.query(`SELECT status, error FROM workflow_runs WHERE run_id = 'wf1-bad'`)).rows[0].status).toBe('failed');
    expect(bad.errors[0]).toMatch(/Sektör yok/);
  });
});

describe('WF2 hazırlık ve gönderim, WF3 metrik', () => {
  it('nitelikli lead’ler için taslak; onay olmadan gönderim yok; DRY_RUN gönderimi', async () => {
    const ctx = await makeCtx(pool);
    await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'beauty', city: 'İstanbul', runId: 'wf1-b' });
    await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'beauty', city: 'İzmir', runId: 'wf1-b2' });
    const p = await runWf2Prepare(pool, ctx.cfg, ctx.ai, { runId: 'wf2-p1' });
    expect(p.candidates).toBeGreaterThan(0);
    expect(p.pending_approval).toBe(p.prepared);
    const p2 = await runWf2Prepare(pool, ctx.cfg, ctx.ai, { runId: 'wf2-p2' });
    expect(p2.candidates).toBe(0);
    const s0 = await runWf2Send(pool, ctx.cfg, ctx.email, { runId: 'wf2-s0' });
    expect(s0.picked).toBe(0);
    // Test alıcısına yönlendirilmiş bir taslak onayla
    const d = (await pool.query(`SELECT d.id, d.business_id FROM message_drafts d WHERE d.status = 'pending_approval' AND d.channel = 'email' LIMIT 1`)).rows[0];
    await pool.query(`UPDATE contacts SET email = 'test@example.com', email_normalized = 'test@example.com' WHERE business_id = $1`, [d.business_id]);
    await pool.query(`UPDATE businesses SET email_public = 'test@example.com' WHERE id = $1`, [d.business_id]);
    const out = await approveDraft(pool, ctx.cfg, d.id, { id: users.owner.id });
    expect(out.outcome).toBe('queued');
    const s1 = await runWf2Send(pool, ctx.cfg, ctx.email, { runId: 'wf2-s1' });
    expect(s1.dry_run).toBe(1);
    expect(ctx.email.sent).toHaveLength(0);
    const m = await runWf3Metrics(pool, { runId: 'wf3-m1', weekly: true });
    expect(m.daily.all.drafts_prepared).toBe(p.prepared);
    expect(m.daily.all.dry_run).toBe(1);
    expect(m.daily.all.sent).toBe(0);
    expect(m.daily.all.approvals_pending).toBe(p.prepared - 1);
    expect(m.daily.beauty.leads_discovered).toBeGreaterThan(0);
    expect(m.daily.education.drafts_prepared).toBeGreaterThanOrEqual(0);
    expect(m.weekly?.days.length).toBe(1);
  });
  it('WF3 inbound toplu işleme ve heartbeat', async () => {
    const ctx = await makeCtx(pool);
    const r = await runWf3Inbound(pool, ctx.ai, { runId: 'wf3-i1', messages: [{ from: 'a@b.example', text: 'ilgileniyorum', provider_message_id: 'x1' }, { from: 'c@d.example', text: 'hayır', provider_message_id: 'x2' }] });
    expect(r.results).toHaveLength(2);
    expect((await pool.query(`SELECT status FROM workflow_runs WHERE run_id = 'wf3-i1'`)).rows[0].status).toBe('succeeded');
  });
});

describe('teklif, abonelik, referans kampanyası', () => {
  it('yer tutucu plan ile teklif oluşturulamaz; fiyat girilince abonelik ve MRR oluşur', async () => {
    const b = (await pool.query(`SELECT b.id, b.sector_key FROM businesses b WHERE b.sector_key = 'beauty' LIMIT 1`)).rows[0];
    const dealId = (await pool.query(`INSERT INTO deals(business_id, stage, service_key) VALUES ($1,'interested','appointment_lead_management') ON CONFLICT DO NOTHING RETURNING id`, [b.id])).rows[0]?.id ?? (await pool.query(`SELECT id FROM deals WHERE business_id = $1 AND stage NOT IN ('won','lost')`, [b.id])).rows[0].id;
    const plan = (await pool.query(`SELECT id FROM price_plans WHERE service_key = 'appointment_lead_management' LIMIT 1`)).rows[0];
    await expect(createQuote(pool, { deal_id: dealId, plan_id: plan.id })).rejects.toThrow(/yer tutucu/i);
    await pool.query('UPDATE price_plans SET setup_fee_cents = 1500000, monthly_fee_cents = 500000 WHERE id = $1', [plan.id]);
    const q = await createQuote(pool, { deal_id: dealId, plan_id: plan.id, discount_pct: 10 });
    await setQuoteStatus(pool, q, 'sent');
    await setQuoteStatus(pool, q, 'accepted');
    const sub = (await pool.query('SELECT * FROM subscriptions WHERE quote_id = $1', [q])).rows[0];
    expect(Number(sub.monthly_fee_cents)).toBe(450000);
    expect((await pool.query('SELECT stage FROM deals WHERE id = $1', [dealId])).rows[0].stage).toBe('won');
    expect((await pool.query('SELECT status FROM businesses WHERE id = $1', [b.id])).rows[0].status).toBe('customer');
    const m = await runWf3Metrics(pool, { runId: 'wf3-m2' });
    expect(m.daily.all.mrr_cents).toBe(450000);
    expect(m.daily.all.deals_won).toBe(1);
    // Referans kampanyası: güzellik → mevzuat kontrolü gerekmez
    const rc = await createReferralCampaign(pool, { business_id: b.id, subscription_id: sub.id, logo_url: 'https://x.example/logo.png' });
    await expect(updateReferralCampaign(pool, rc, { video_status: 'published' })).rejects.toThrow(/geçersiz/);
    await updateReferralCampaign(pool, rc, { video_status: 'uploaded', video_url: 'https://x.example/v.mp4' });
    await updateReferralCampaign(pool, rc, { video_status: 'customer_review' });
    await expect(updateReferralCampaign(pool, rc, { share_verified: true })).rejects.toThrow(/share_url/);
    let c = await updateReferralCampaign(pool, rc, { customer_approval_status: 'approved', share_url: 'https://instagram.com/p/x', share_verified: true, repost_permission: true });
    expect(c.discount_status).toBe('eligible');
    c = await updateReferralCampaign(pool, rc, { video_status: 'approved' });
    c = await updateReferralCampaign(pool, rc, { video_status: 'published', discount_status: 'applied', accounting_status: 'credited' });
    expect(c.video_status).toBe('published'); expect(c.discount_status).toBe('applied');
  });
  it('klinik kampanyası mevzuat onayı olmadan yayınlanamaz ve indirim hakkı doğmaz', async () => {
    const ctx = await makeCtx(pool);
    await runWf1(pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, lookup: ctx.lookup, transport: ctx.transport }, { sectorKey: 'clinic', city: 'İstanbul', runId: 'wf1-c' });
    const b = (await pool.query(`SELECT id FROM businesses WHERE sector_key = 'clinic' LIMIT 1`)).rows[0];
    const rc = await createReferralCampaign(pool, { business_id: b.id });
    expect((await pool.query('SELECT compliance_status FROM referral_campaigns WHERE id = $1', [rc])).rows[0].compliance_status).toBe('pending');
    expect((await pool.query(`SELECT 1 FROM tasks WHERE kind = 'compliance_check' AND business_id = $1`, [b.id])).rowCount).toBe(1);
    await updateReferralCampaign(pool, rc, { video_status: 'uploaded', video_url: 'https://x.example/v.mp4' });
    await updateReferralCampaign(pool, rc, { video_status: 'customer_review' });
    const c = await updateReferralCampaign(pool, rc, { customer_approval_status: 'approved', share_url: 'https://instagram.com/p/y', share_verified: true });
    expect(c.discount_status).toBe('pending');
    await updateReferralCampaign(pool, rc, { video_status: 'approved' });
    await expect(updateReferralCampaign(pool, rc, { video_status: 'published' })).rejects.toThrow(/Mevzuat/);
  });
});

describe('e-posta ön kontrol', () => {
  it('DNS kayıtlarını değerlendirir (enjekte çözümleyici)', async () => {
    const ctx = await makeCtx(pool, { EMAIL_PROVIDER: 'smtp' as any, SMTP_HOST: 'smtp.test.invalid', EMAIL_FROM_ADDRESS: 'iletisim@test.invalid', EMAIL_REPLY_DOMAIN: 'test.invalid' });
    const txt: Record<string, string[][]> = { 'test.invalid': [['v=spf1 include:_spf.example -all']], '_dmarc.test.invalid': [['v=DMARC1; p=quarantine']], 'default._domainkey.test.invalid': [['v=DKIM1; k=rsa; p=abc']] };
    const checks = await runEmailPreflight(ctx.cfg, { resolveTxt: async (n) => { if (!txt[n]) throw new Error('ENOTFOUND'); return txt[n]; }, resolveMx: async () => [{ exchange: 'mx.test.invalid', priority: 10 }] });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by['dns.spf'].ok).toBe(true); expect(by['dns.dmarc'].ok).toBe(true); expect(by['dns.dkim'].ok).toBe(true); expect(by['dns.mx.reply_domain'].ok).toBe(true); expect(by['alignment.reply_domain'].ok).toBe(true);
    const none = await runEmailPreflight(ctx.cfg, { resolveTxt: async () => { throw new Error('ENOTFOUND'); }, resolveMx: async () => [] });
    expect(none.find((c) => c.name === 'dns.spf')?.ok).toBe(false);
    expect(none.find((c) => c.name === 'dns.mx.reply_domain')?.ok).toBe(false);
  });
});
