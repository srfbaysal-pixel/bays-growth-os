import type { Queryable } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getSector } from '../sectors/loader.js';

export async function createReferralCampaign(db: Queryable, input: { business_id: string; subscription_id?: string | null; logo_url?: string | null; brand_info?: Record<string, unknown>; video_template?: string | null }): Promise<string> {
  const b = (await db.query('SELECT id, sector_key FROM businesses WHERE id = $1', [input.business_id])).rows[0];
  if (!b) throw notFound('İşletme yok');
  const sector = await getSector(db, b.sector_key);
  const compliance = sector?.compliance.requires_legal_review_for_campaign ? 'pending' : 'not_required';
  const r = await db.query(
    `INSERT INTO referral_campaigns(business_id, subscription_id, logo_url, brand_info, video_template, compliance_status, video_status)
     VALUES ($1,$2,$3,$4,$5,$6,'brief_ready') ON CONFLICT (business_id, subscription_id) DO UPDATE SET updated_at = now() RETURNING id`,
    [b.id, input.subscription_id ?? null, input.logo_url ?? null, JSON.stringify(input.brand_info ?? {}), input.video_template ?? 'brand-intro-v1', compliance]
  );
  if (compliance === 'pending') {
    await db.query(`INSERT INTO tasks(business_id, kind, title, description, dedup_key) VALUES ($1,'compliance_check',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [b.id, 'Klinik kampanyası — mevzuat kontrolü', 'Sağlık kuruluşu tanıtım mevzuatına göre video ve paylaşım hukuki kontrolden geçmeden yayınlanamaz.', `compliance:${r.rows[0].id}`]);
  }
  return r.rows[0].id;
}

const VIDEO_FLOW: Record<string, string[]> = {
  not_started: ['brief_ready'], brief_ready: ['in_production', 'uploaded'], in_production: ['uploaded'],
  uploaded: ['customer_review'], customer_review: ['approved', 'uploaded'], approved: ['published'], published: []
};

export async function updateReferralCampaign(db: Queryable, id: string, patch: Partial<{ video_status: string; video_url: string | null; customer_approval_status: string; share_url: string | null; share_verified: boolean; share_verified_by: string | null; repost_permission: boolean; compliance_status: string; accounting_status: string; notes: string | null; discount_status: string }>): Promise<any> {
  const c = (await db.query('SELECT * FROM referral_campaigns WHERE id = $1', [id])).rows[0];
  if (!c) throw notFound('Kampanya yok');
  const next = { ...c, ...patch };
  if (patch.video_status && patch.video_status !== c.video_status && !VIDEO_FLOW[c.video_status]?.includes(patch.video_status)) throw badRequest(`Video durumu ${c.video_status} → ${patch.video_status} geçişi geçersiz`);
  if (patch.video_status === 'published' && c.compliance_status === 'pending') throw badRequest('Mevzuat kontrolü tamamlanmadan yayınlanamaz');
  if (patch.video_status === 'published' && next.customer_approval_status !== 'approved') throw badRequest('Müşteri onayı olmadan yayınlanamaz');
  if (patch.customer_approval_status === 'approved') next.customer_approved_at = new Date();
  if (patch.share_verified === true) {
    if (!next.share_url) throw badRequest('Paylaşım doğrulaması için share_url gerekli');
    next.share_verified_at = new Date();
    // İndirim hakkı: müşteri onayı + paylaşım doğrulaması + (klinikte) mevzuat onayı
    if (next.customer_approval_status === 'approved' && next.compliance_status !== 'pending' && next.compliance_status !== 'rejected') next.discount_status = 'eligible';
  }
  if (patch.discount_status === 'applied' && next.discount_status !== 'eligible' && c.discount_status !== 'eligible') throw badRequest('İndirim yalnız "eligible" durumundan uygulanabilir');
  await db.query(
    `UPDATE referral_campaigns SET video_status=$2, video_url=$3, customer_approval_status=$4, customer_approved_at=$5, share_url=$6, share_verified=$7, share_verified_at=$8, share_verified_by=$9,
       repost_permission=$10, compliance_status=$11, accounting_status=$12, notes=$13, discount_status=$14 WHERE id = $1`,
    [id, next.video_status, next.video_url, next.customer_approval_status, next.customer_approved_at, next.share_url, next.share_verified, next.share_verified_at, next.share_verified_by, next.repost_permission, next.compliance_status, next.accounting_status, next.notes, next.discount_status]
  );
  return (await db.query('SELECT * FROM referral_campaigns WHERE id = $1', [id])).rows[0];
}
