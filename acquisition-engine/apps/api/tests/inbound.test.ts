import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, closeTestPool, makeCtx, seedUsers } from './helpers.js';
import { upsertBusiness, recordEvidence, upsertContact } from '../src/discovery/pipeline.js';
import { getSector } from '../src/sectors/loader.js';
import { scoreBusiness } from '../src/scoring/score.js';
import { prepareDraftForBusiness } from '../src/outreach/drafts.js';
import { approveDraft } from '../src/outreach/approvals.js';
import { processSendQueue } from '../src/outreach/sender.js';
import { processInbound, extractReplyToken } from '../src/inbound/process.js';
import { classifyByRules, stripQuoted } from '../src/inbound/classify.js';
import type pg from 'pg';

let pool: pg.Pool;
let users: Awaited<ReturnType<typeof seedUsers>>;
beforeAll(async () => { pool = await freshDb(); users = await seedUsers(pool); });
afterAll(closeTestPool);

async function sentJob(name: string, email: string) {
  const ctx = await makeCtx(pool, { DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any, EMAIL_DAILY_QUOTA: 100 as any, EMAIL_HOURLY_QUOTA: 100 as any });
  const sector = (await getSector(pool, 'education'))!;
  const up = await upsertBusiness(pool, 'education', { source_key: 'mock', name, city: 'İstanbul', email, website: `https://${email.split('@')[1]}` });
  await upsertContact(pool, up.id, { email, source_key: 'mock', is_primary: true });
  for (const [f, v] of [['has_online_booking', false], ['has_instagram', true], ['has_public_email', true], ['has_phone', true], ['has_whatsapp_link', false], ['has_website', true]] as const) await recordEvidence(pool, up.id, 'mock', 'observation', f, v);
  await scoreBusiness(pool, sector, up.id);
  const r = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, sector, up.id);
  await approveDraft(pool, ctx.cfg, r.draft_id!, { id: users.owner.id });
  await processSendQueue(pool, ctx.cfg, ctx.email);
  const job = (await pool.query('SELECT * FROM send_jobs WHERE business_id = $1', [up.id])).rows[0];
  expect(job.status).toBe('accepted');
  return { ctx, business_id: up.id, job, draft_id: r.draft_id! };
}

describe('yanıt sınıflandırma kuralları', () => {
  it('ret, ilgi, görüşme, ofis dışı, bounce', () => {
    expect(classifyByRules('', 'Hayır, ilgilenmiyoruz').classification).toBe('rejected');
    expect(classifyByRules('', 'Merhaba, detay alabilir miyiz?').classification).toBe('interested');
    expect(classifyByRules('', 'Yarın saat 14 görüşme yapabiliriz').classification).toBe('meeting_request');
    expect(classifyByRules('Automatic reply', 'Ofis dışındayım').classification).toBe('out_of_office');
    expect(classifyByRules('Mail delivery failed', 'user unknown').classification).toBe('bounce');
    expect(classifyByRules('', 'Tamam.').classification).toBe('unknown');
  });
  it('alıntı metni ayıklanır', () => {
    expect(stripQuoted('Evet olur\n\nOn Mon, X wrote:\n> hayır')).toBe('Evet olur');
    expect(extractReplyToken('reply+abc123XYZ_-@test.invalid')).toBe('abc123XYZ_-');
    expect(extractReplyToken('info@test.invalid')).toBeNull();
  });
});

describe('gelen yanıt işleme', () => {
  it('reply token ile doğru işletmeye eşleşir; ilgi → fırsat + görev', async () => {
    const { ctx, business_id, job } = await sentJob('Mavi Dil Kursu', 'info@mavidil.example');
    const r = await processInbound(pool, ctx.ai, { from: 'Ayşe <ayse@gmail.com>', to: `reply+${job.reply_token}@test.invalid`, subject: 'Re: teklif', text: 'Merhaba, detay alabilir miyiz?', provider_message_id: 'm-1' });
    expect(r.matched).toBe(true); expect(r.match_method).toBe('reply_token'); expect(r.business_id).toBe(business_id);
    expect(r.classification).toBe('interested');
    expect((await pool.query(`SELECT stage FROM deals WHERE business_id = $1`, [business_id])).rows[0].stage).toBe('interested');
    expect((await pool.query(`SELECT 1 FROM tasks WHERE business_id = $1 AND kind = 'follow_up'`, [business_id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT status FROM businesses WHERE id = $1`, [business_id])).rows[0].status).toBe('replied');
    // Mükerrer teslim
    const dup = await processInbound(pool, ctx.ai, { from: 'Ayşe <ayse@gmail.com>', to: `reply+${job.reply_token}@test.invalid`, subject: 'Re: teklif', text: 'Merhaba, detay alabilir miyiz?', provider_message_id: 'm-1' });
    expect(dup.duplicate).toBe(true);
    expect(Number((await pool.query('SELECT COUNT(*) n FROM inbound_messages')).rows[0].n)).toBe(1);
  });
  it('In-Reply-To Message-ID ile eşleşir; görüşme talebi', async () => {
    const { ctx, business_id, job } = await sentJob('Zirve Kurs', 'kayit@zirvekurs.example');
    const r = await processInbound(pool, ctx.ai, { from: 'kayit@zirvekurs.example', to: 'iletisim@test.invalid', subject: 'Re:', text: 'Salı saat 11 görüşme olur mu?', in_reply_to: job.message_id, provider_message_id: 'm-2' });
    expect(r.match_method).toBe('message_id'); expect(r.business_id).toBe(business_id); expect(r.classification).toBe('meeting_request');
    expect((await pool.query(`SELECT stage FROM deals WHERE business_id = $1`, [business_id])).rows[0].stage).toBe('meeting');
  });
  it('kişi e-postası ile eşleşir; ret → tüm kanallarda engelleme, fırsat kaybedildi', async () => {
    const { ctx, business_id } = await sentJob('Adım Merkezi', 'iletisim@adim.example');
    const r = await processInbound(pool, ctx.ai, { from: 'iletisim@adim.example', subject: 'Re:', text: 'Hayır, bir daha yazmayın lütfen.', provider_message_id: 'm-3' });
    expect(r.match_method).toBe('contact_email'); expect(r.classification).toBe('rejected');
    expect((await pool.query(`SELECT status FROM businesses WHERE id = $1`, [business_id])).rows[0].status).toBe('suppressed');
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE kind = 'email' AND value = 'iletisim@adim.example'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE kind = 'domain' AND value = 'adim.example'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT stage FROM deals WHERE business_id = $1`, [business_id])).rows[0].stage).toBe('lost');
  });
  it('eşleşmeyen yanıt inceleme görevi açar; başka işletmeye bağlanmaz', async () => {
    const ctx = await makeCtx(pool);
    const r = await processInbound(pool, ctx.ai, { from: 'random@gmail.com', subject: 'merhaba', text: 'ilgileniyorum', provider_message_id: 'm-4' });
    expect(r.matched).toBe(false); expect(r.business_id).toBeNull();
    expect((await pool.query(`SELECT 1 FROM tasks WHERE title LIKE 'Eşleşmeyen gelen e-posta%'`)).rowCount).toBe(1);
  });
  it('bounce → engelleme ve iş durumu', async () => {
    const { ctx, job } = await sentJob('Bounce Kurs', 'yok@bounce.example');
    const r = await processInbound(pool, ctx.ai, { from: 'MAILER-DAEMON@mail.example', to: `reply+${job.reply_token}@test.invalid`, subject: 'Mail delivery failed', text: 'user unknown', provider_message_id: 'm-5' });
    expect(r.classification).toBe('bounce');
    expect((await pool.query('SELECT status FROM send_jobs WHERE id = $1', [job.id])).rows[0].status).toBe('bounced');
    expect((await pool.query(`SELECT 1 FROM suppressions WHERE kind = 'email' AND value = 'yok@bounce.example'`)).rowCount).toBe(1);
  });
});
