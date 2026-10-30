import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import { emailDomain } from '../lib/normalize.js';

export type Channel = 'email' | 'whatsapp' | 'instagram' | 'linkedin' | 'phone';
export type PolicyMode = 'auto_send' | 'manual_task' | 'blocked';
export interface PolicyDecision { mode: PolicyMode; reasons: string[]; test_mode: boolean }

export interface PolicyContext {
  cfg: Config;
  channel: Channel;
  sectorKey: string;
  business: { id: string; domain?: string | null; phone_e164?: string | null; instagram_handle?: string | null; status: string };
  toAddress?: string | null;        // e-posta adresi veya telefon
  permissionStatus?: string | null; // channel_permissions.status
  suppressed: boolean;
  outreachPaused: boolean;
}

/**
 * Kanal politikası — tek doğruluk kaynağı.
 * Varsayılan güvenli: emin olunmayan her durum manuel görev veya engeldir.
 */
export function decidePolicy(ctx: PolicyContext): PolicyDecision {
  const reasons: string[] = [];
  const testMode = ctx.cfg.DRY_RUN || !ctx.cfg.LIVE_OUTREACH_ENABLED;
  if (ctx.suppressed) return { mode: 'blocked', reasons: ['Engelleme/ret listesinde'], test_mode: testMode };
  if (ctx.business.status === 'suppressed' || ctx.business.status === 'customer') return { mode: 'blocked', reasons: [`İşletme durumu: ${ctx.business.status}`], test_mode: testMode };
  if (ctx.permissionStatus === 'opt_out' || ctx.permissionStatus === 'blocked') return { mode: 'blocked', reasons: ['Kanal izni: ' + ctx.permissionStatus], test_mode: testMode };

  // Instagram / LinkedIn: yetkisiz otomatik soğuk DM hiçbir zaman
  if (ctx.channel === 'instagram' || ctx.channel === 'linkedin') return { mode: 'manual_task', reasons: ['Bu kanalda otomatik soğuk mesaj yapılmaz (platform kuralları)'], test_mode: testMode };
  if (ctx.channel === 'phone') return { mode: 'manual_task', reasons: ['Telefon araması manuel'], test_mode: testMode };

  if (ctx.channel === 'whatsapp') {
    if (!ctx.cfg.WHATSAPP_ENABLED) reasons.push('WHATSAPP_ENABLED=false');
    if (ctx.permissionStatus !== 'opt_in') reasons.push('WhatsApp için açık opt-in yok (Meta kuralları: iş başlatılan konuşma yalnız onaylı şablon ve opt-in ile)');
    if (!ctx.cfg.COMPLIANCE_IYS_VERIFIED) reasons.push('İYS doğrulaması yapılmadı');
    return { mode: reasons.length ? 'manual_task' : 'auto_send', reasons, test_mode: testMode };
  }

  // email
  if (!ctx.toAddress) return { mode: 'manual_task', reasons: ['E-posta adresi yok'], test_mode: testMode };
  if (ctx.outreachPaused) return { mode: 'blocked', reasons: ['Gönderim durduruldu (kill-switch)'], test_mode: testMode };
  if (!ctx.cfg.COMPLIANCE_IYS_VERIFIED || !ctx.cfg.COMPLIANCE_KVKK_VERIFIED) {
    reasons.push('Ticari elektronik ileti / İYS / KVKK uyumluluğu doğrulanmadı (COMPLIANCE_*_VERIFIED=false)');
  }
  if (ctx.sectorKey === 'clinic' && !ctx.cfg.COMPLIANCE_CLINIC_ADVERTISING_VERIFIED) reasons.push('Klinik tanıtım mevzuatı doğrulanmadı');
  if (ctx.permissionStatus && !['allowed', 'opt_in', 'unknown'].includes(ctx.permissionStatus)) reasons.push('Kanal izni uygun değil');
  if (!ctx.cfg.LIVE_OUTREACH_ENABLED) reasons.push('LIVE_OUTREACH_ENABLED=false');
  if (ctx.cfg.DRY_RUN) reasons.push('DRY_RUN=true');
  // Test modunda yalnız izinli test alıcıları gönderilebilir; gerçek alıcılar manuel göreve düşer
  if (testMode) {
    const allowed = ctx.cfg.TEST_RECIPIENTS.includes(ctx.toAddress.toLowerCase());
    if (!allowed) return { mode: 'manual_task', reasons: [...reasons, 'Test modu: alıcı TEST_RECIPIENTS listesinde değil'], test_mode: true };
    return { mode: 'auto_send', reasons: [...reasons, 'Test modu: izinli test alıcısı'], test_mode: true };
  }
  return { mode: reasons.length ? 'manual_task' : 'auto_send', reasons, test_mode: false };
}

export async function isSuppressed(db: Queryable, b: { id: string; domain?: string | null; phone_e164?: string | null; instagram_handle?: string | null }, email?: string | null): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM suppressions WHERE (kind = 'business' AND value = $1)
        OR (kind = 'email' AND $2::text IS NOT NULL AND value = $2)
        OR (kind = 'domain' AND (($3::text IS NOT NULL AND value = $3) OR ($4::text IS NOT NULL AND value = $4)))
        OR (kind = 'phone' AND $5::text IS NOT NULL AND value = $5)
        OR (kind = 'instagram' AND $6::text IS NOT NULL AND value = $6)
      LIMIT 1`,
    [b.id, email?.toLowerCase() ?? null, b.domain ?? null, emailDomain(email ?? null), b.phone_e164 ?? null, b.instagram_handle ?? null]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function isOutreachPaused(db: Queryable): Promise<{ paused: boolean; reason: string | null }> {
  const r = await db.query(`SELECT value FROM system_flags WHERE key = 'outreach_paused'`);
  const v = r.rows[0]?.value ?? { paused: false, reason: null };
  return { paused: Boolean(v.paused), reason: v.reason ?? null };
}

export async function setOutreachPaused(db: Queryable, paused: boolean, reason: string | null, by: string): Promise<void> {
  await db.query(
    `INSERT INTO system_flags(key, value, updated_by) VALUES ('outreach_paused', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify({ paused, reason, at: new Date().toISOString() }), by]
  );
}

/** Tüm kanallarda engelleme: ret alındığında çağrılır. */
export async function suppressBusinessEverywhere(db: Queryable, businessId: string, reason: string, source: string, by?: string | null): Promise<void> {
  const b = (await db.query('SELECT id, domain, phone_e164, instagram_handle, email_public FROM businesses WHERE id = $1', [businessId])).rows[0];
  if (!b) return;
  const rows: Array<[string, string]> = [['business', b.id]];
  if (b.domain) rows.push(['domain', b.domain]);
  if (b.phone_e164) rows.push(['phone', b.phone_e164]);
  if (b.instagram_handle) rows.push(['instagram', b.instagram_handle]);
  if (b.email_public) rows.push(['email', b.email_public]);
  const contacts = await db.query('SELECT email_normalized, phone_e164 FROM contacts WHERE business_id = $1', [businessId]);
  for (const c of contacts.rows) {
    if (c.email_normalized) rows.push(['email', c.email_normalized]);
    if (c.phone_e164) rows.push(['phone', c.phone_e164]);
  }
  for (const [kind, value] of rows) {
    await db.query(`INSERT INTO suppressions(kind, value, reason, source, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (kind, value) DO NOTHING`, [kind, value, reason, source, by ?? null]);
  }
  await db.query(`UPDATE businesses SET status = 'suppressed' WHERE id = $1`, [businessId]);
  await db.query(`UPDATE channel_permissions SET status = 'opt_out', updated_at = now() WHERE business_id = $1`, [businessId]);
  for (const ch of ['email', 'whatsapp', 'instagram', 'linkedin', 'phone']) {
    await db.query(
      `INSERT INTO channel_permissions(business_id, channel, status, basis) VALUES ($1,$2,'opt_out',$3)
       ON CONFLICT DO NOTHING`, [businessId, ch, reason]
    );
  }
  await db.query(`UPDATE message_drafts SET status = 'cancelled' WHERE business_id = $1 AND status IN ('pending_approval','approved','queued')`, [businessId]);
  await db.query(`UPDATE send_jobs SET status = 'blocked', last_error = $2 WHERE business_id = $1 AND status IN ('queued','sending')`, [businessId, reason]);
}
