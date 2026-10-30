import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, closeTestPool, makeCtx } from './helpers.js';
import { validateDraft } from '../src/outreach/validate.js';
import { renderTemplateDraft } from '../src/outreach/templates.js';
import { prepareDraftForBusiness } from '../src/outreach/drafts.js';
import { upsertBusiness, recordEvidence, upsertContact } from '../src/discovery/pipeline.js';
import { getSector } from '../src/sectors/loader.js';
import { scoreBusiness } from '../src/scoring/score.js';
import type pg from 'pg';
import type { DraftInput } from '../src/ai/types.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(closeTestPool);

const input: DraftInput = { sectorKey: 'beauty', sectorName: 'Güzellik', channel: 'email', business: { name: 'Studio Elif Kuaför', city: 'İstanbul' }, serviceName: 'Randevu ve talep yönetimi', angle: 'randevu taleplerinin otomatik toplanması', facts: [{ id: 'f1', field: 'has_online_booking', value: false, label: 'Online randevu yok' }], restrictions: [], senderName: 'Şeref' };

describe('taslak doğrulama (yanlış kişiselleştirme engeli)', () => {
  it('şablon taslağı geçer ve yalnız doğrulanmış kanıtı kullanır', () => {
    const d = renderTemplateDraft(input);
    expect(d.facts_used).toEqual(['f1']);
    expect(validateDraft(d, input).ok).toBe(true);
  });
  it('yer tutucu, yanlış işletme adı, fiyat, yasak iddia reddedilir', () => {
    const d = renderTemplateDraft(input);
    expect(validateDraft({ ...d, body: d.body.replace('Studio Elif Kuaför', 'Nur Güzellik Salonu') }, input).errors).toContain('İşletme adı gövdede tam olarak geçmiyor');
    expect(validateDraft({ ...d, body: d.body + ' {{isim}}' }, input).errors.join()).toMatch(/yer tutucu/);
    expect(validateDraft({ ...d, body: d.body + ' Aylık 1.500 TL' }, input).errors.join()).toMatch(/fiyat/);
    expect(validateDraft({ ...d, body: d.body + ' %200 artış garanti ediyoruz' }, input).errors.join()).toMatch(/Yasak iddia/);
    expect(validateDraft({ ...d, facts_used: ['sahte'] }, input).errors.join()).toMatch(/Bilinmeyen kanıt/);
    expect(validateDraft({ ...d, body: d.body.replace(/İlgilenmiyorsanız.*\n/, '') }, input).errors.join()).toMatch(/Ret\/çıkış/);
  });
  it('klinik taslağında sağlık verisi ifadesi reddedilir', () => {
    const clin = { ...input, sectorKey: 'clinic' };
    const d = renderTemplateDraft(clin);
    expect(d.body).toMatch(/tıbbi tavsiye vermez/);
    expect(validateDraft({ ...d, body: d.body + ' hasta kayıtlarınızı toplarız' }, clin).ok).toBe(false);
  });
});

describe('taslak hazırlama', () => {
  it('nitelikli işletme için onay kuyruğuna taslak ekler; idempotent', async () => {
    const ctx = await makeCtx(pool);
    const sector = (await getSector(pool, 'beauty'))!;
    const up = await upsertBusiness(pool, 'beauty', { source_key: 'mock', name: 'Studio Elif Kuaför', website: 'https://studioelif.example', city: 'İstanbul', email: 'info@studioelif.example' });
    await upsertContact(pool, up.id, { email: 'info@studioelif.example', source_key: 'mock', is_primary: true });
    await recordEvidence(pool, up.id, 'website', 'observation', 'has_online_booking', false);
    await recordEvidence(pool, up.id, 'website', 'observation', 'has_instagram', true);
    await recordEvidence(pool, up.id, 'mock', 'observation', 'has_public_email', true);
    await recordEvidence(pool, up.id, 'mock', 'observation', 'has_phone', true);
    const sc = await scoreBusiness(pool, sector, up.id);
    expect(sc.qualified).toBe(true);
    const r1 = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, sector, up.id);
    expect(r1.status).toBe('pending_approval');
    expect(r1.validation?.ok).toBe(true);
    expect(r1.policy?.mode).toBe('manual_task'); // test modu, alıcı test listesinde değil
    const r2 = await prepareDraftForBusiness(pool, ctx.cfg, ctx.ai, sector, up.id);
    expect(r2.draft_id).toBe(r1.draft_id);
    expect(r2.skipped).toMatch(/idempotent/);
    const d = (await pool.query('SELECT * FROM message_drafts WHERE id = $1', [r1.draft_id])).rows[0];
    expect(d.body).toContain('Studio Elif Kuaför');
    expect((d.facts_used as string[]).length).toBeGreaterThan(0);
    const inf = await pool.query(`SELECT 1 FROM research_evidence WHERE id = ANY($1::uuid[]) AND kind = 'inference'`, [d.facts_used]);
    expect(inf.rowCount).toBe(0);
  });
  it('AI çıktısı doğrulamadan geçmezse şablona düşer', async () => {
    const ctx = await makeCtx(pool);
    const badAi = { ...ctx.ai, key: 'bad', draft: async () => ({ subject: 'x', body: 'Merhaba Başka Firma, %300 artış garanti ediyoruz', facts_used: [] }) } as any;
    const sector = (await getSector(pool, 'beauty'))!;
    const up = await upsertBusiness(pool, 'beauty', { source_key: 'mock', name: 'Nur Güzellik Salonu', city: 'İzmir', email: 'nur@nur.example' });
    await recordEvidence(pool, up.id, 'mock', 'observation', 'has_online_booking', false);
    await recordEvidence(pool, up.id, 'mock', 'observation', 'has_instagram', true);
    await recordEvidence(pool, up.id, 'mock', 'observation', 'has_public_email', true);
    await recordEvidence(pool, up.id, 'mock', 'observation', 'has_phone', true);
    await scoreBusiness(pool, sector, up.id);
    const r = await prepareDraftForBusiness(pool, ctx.cfg, badAi, sector, up.id);
    expect(r.status).toBe('pending_approval');
    const d = (await pool.query('SELECT generator, body, validation FROM message_drafts WHERE id = $1', [r.draft_id])).rows[0];
    expect(d.generator).toBe('template_fallback');
    expect(d.body).toContain('Nur Güzellik Salonu');
    expect(JSON.stringify(d.validation)).toMatch(/AI taslağı reddedildi/);
  });
});
