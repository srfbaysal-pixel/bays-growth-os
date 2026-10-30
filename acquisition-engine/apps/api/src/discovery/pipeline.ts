import type { Queryable } from '../db/pool.js';
import type { DiscoveredBusiness, WebsiteFacts } from './types.js';
import { normalizeName, normalizePhoneTR, normalizeEmail, extractDomain, buildDedupKey } from '../lib/normalize.js';
import type { SectorConfig } from '../sectors/types.js';

export interface UpsertResult { id: string; created: boolean; merged: boolean }

export function isExcluded(sector: SectorConfig, name: string): boolean {
  const n = name.toLocaleLowerCase('tr-TR');
  return (sector.discovery.exclude_name_patterns ?? []).some((p) => n.includes(p.toLocaleLowerCase('tr-TR')));
}

/**
 * İşletmeyi normalize eder ve mükerrer kaydı önleyerek kaydeder.
 * Eşleşme sırası: google_place_id → dedup_key → domain → telefon → ad+şehir.
 */
export async function upsertBusiness(db: Queryable, sectorKey: string, b: DiscoveredBusiness): Promise<UpsertResult> {
  const normalized_name = normalizeName(b.name);
  const phone_e164 = normalizePhoneTR(b.phone);
  const domain = extractDomain(b.website);
  const email_public = normalizeEmail(b.email);
  const city = b.city?.trim() || null;
  const dedup_key = buildDedupKey({ google_place_id: b.external_id, domain, phone_e164, normalized_name, city });

  const existing = await db.query(
    `SELECT id FROM businesses
      WHERE ($1::text IS NOT NULL AND google_place_id = $1)
         OR dedup_key = $2
         OR ($3::text IS NOT NULL AND domain = $3)
         OR ($4::text IS NOT NULL AND phone_e164 = $4)
         OR (normalized_name = $5 AND city IS NOT DISTINCT FROM $6)
      ORDER BY created_at LIMIT 1`,
    [b.external_id ?? null, dedup_key, domain, phone_e164, normalized_name, city]
  );
  if (existing.rows[0]) {
    const id = existing.rows[0].id as string;
    // Eksik alanları tamamla, mevcut değerleri ezme
    await db.query(
      `UPDATE businesses SET
         website = COALESCE(website, $2), domain = COALESCE(domain, $3), phone_e164 = COALESCE(phone_e164, $4),
         email_public = COALESCE(email_public, $5), city = COALESCE(city, $6), district = COALESCE(district, $7),
         address = COALESCE(address, $8), google_place_id = COALESCE(google_place_id, $9),
         instagram_handle = COALESCE(instagram_handle, $10), rating = COALESCE($11, rating), review_count = COALESCE($12, review_count)
       WHERE id = $1`,
      [id, b.website ?? null, domain, phone_e164, email_public, city, b.district ?? null, b.address ?? null, b.external_id ?? null, b.instagram_handle ?? null, b.rating ?? null, b.review_count ?? null]
    );
    return { id, created: false, merged: true };
  }
  const ins = await db.query(
    `INSERT INTO businesses(sector_key, name, normalized_name, dedup_key, website, domain, phone_e164, email_public, city, district, address, google_place_id, instagram_handle, rating, review_count, discovered_via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (dedup_key) DO UPDATE SET updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [sectorKey, b.name.trim(), normalized_name, dedup_key, b.website ?? null, domain, phone_e164, email_public, city, b.district ?? null, b.address ?? null, b.external_id ?? null, b.instagram_handle ?? null, b.rating ?? null, b.review_count ?? null, b.source_key]
  );
  return { id: ins.rows[0].id, created: Boolean(ins.rows[0].created), merged: !ins.rows[0].created };
}

export async function recordEvidence(db: Queryable, businessId: string, sourceKey: string, kind: 'observation' | 'inference', field: string, value: unknown, confidence = 1, evidenceUrl?: string | null): Promise<void> {
  await db.query(
    `INSERT INTO research_evidence(business_id, source_key, kind, field, value, confidence, evidence_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, source_key, kind, field) DO UPDATE SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, evidence_url = EXCLUDED.evidence_url, captured_at = now()`,
    [businessId, sourceKey, kind, field, JSON.stringify(value), confidence, evidenceUrl ?? null]
  );
}

/** Keşif kaynağından gelen temel gözlemleri kanıt tablosuna yazar. */
export async function recordDiscoveryObservations(db: Queryable, businessId: string, b: DiscoveredBusiness): Promise<void> {
  const src = b.source_key;
  await recordEvidence(db, businessId, src, 'observation', 'has_website', Boolean(b.website), 1, b.evidence_url);
  await recordEvidence(db, businessId, src, 'observation', 'has_phone', Boolean(normalizePhoneTR(b.phone)), 1, b.evidence_url);
  if (b.rating != null) await recordEvidence(db, businessId, src, 'observation', 'rating_gte_4_3', b.rating >= 4.3, 1, b.evidence_url);
  if (b.review_count != null) await recordEvidence(db, businessId, src, 'observation', 'review_count_gte_20', b.review_count >= 20, 1, b.evidence_url);
  if (b.email) await recordEvidence(db, businessId, src, 'observation', 'has_public_email', Boolean(normalizeEmail(b.email)), 1, b.evidence_url);
  if (b.instagram_handle) await recordEvidence(db, businessId, src, 'observation', 'has_instagram', true, 1, b.evidence_url);
}

export async function recordWebsiteObservations(db: Queryable, businessId: string, facts: WebsiteFacts): Promise<void> {
  if (!facts.fetched) {
    await recordEvidence(db, businessId, 'website', 'observation', 'website_fetch_failed', { error: facts.error ?? null, blocked_by_robots: facts.blocked_by_robots ?? false }, 1, facts.url);
    return;
  }
  await recordEvidence(db, businessId, 'website', 'observation', 'has_whatsapp_link', facts.has_whatsapp_link, 1, facts.url);
  await recordEvidence(db, businessId, 'website', 'observation', 'has_online_booking', facts.has_online_booking, 1, facts.url);
  await recordEvidence(db, businessId, 'website', 'observation', 'has_instagram', facts.has_instagram, 1, facts.url);
  await recordEvidence(db, businessId, 'website', 'observation', 'has_public_email', facts.emails.length > 0, 1, facts.url);
  if (facts.title) await recordEvidence(db, businessId, 'website', 'observation', 'site_title', facts.title, 1, facts.url);
  if (facts.instagram_handle) await db.query('UPDATE businesses SET instagram_handle = COALESCE(instagram_handle, $2) WHERE id = $1', [businessId, facts.instagram_handle]);
  const email = normalizeEmail(facts.emails[0]);
  if (email) {
    await db.query('UPDATE businesses SET email_public = COALESCE(email_public, $2) WHERE id = $1', [businessId, email]);
    await upsertContact(db, businessId, { email, source_key: 'website', is_primary: true });
  }
}

export async function upsertContact(db: Queryable, businessId: string, c: { email?: string | null; phone?: string | null; full_name?: string | null; role_title?: string | null; source_key: string; is_primary?: boolean }): Promise<string | null> {
  const email = normalizeEmail(c.email);
  const phone = normalizePhoneTR(c.phone);
  if (!email && !phone) return null;
  const r = await db.query(
    `INSERT INTO contacts(business_id, full_name, role_title, email, email_normalized, phone_e164, source_key, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (business_id, email_normalized) DO UPDATE SET phone_e164 = COALESCE(contacts.phone_e164, EXCLUDED.phone_e164), full_name = COALESCE(contacts.full_name, EXCLUDED.full_name)
     RETURNING id`,
    [businessId, c.full_name ?? null, c.role_title ?? null, email ? c.email!.trim() : null, email, phone, c.source_key, c.is_primary ?? false]
  );
  return r.rows[0]?.id ?? null;
}
