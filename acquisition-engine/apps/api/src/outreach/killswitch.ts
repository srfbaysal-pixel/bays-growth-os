import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import { dayBucket, hourBucket } from '../lib/normalize.js';
import { isOutreachPaused, setOutreachPaused } from './policy.js';
import { notifyAdmin } from '../health/notify.js';

/**
 * D6 — Bounce oranı semantiği (son 24 saat, gerçek gönderimler; dry-run hariç):
 *  - sent24h      : sağlayıcıya ulaşan TEKİL gönderim işi sayısı (accepted VEYA reject olayı olan işler).
 *  - bounced24h   : bunlardan bounce / complaint / reject olayı olan TEKİL iş sayısı
 *                   (accepted→delivered ikinci kez saymaz; aynı işe yinelenen bounce bir kez sayılır).
 *  - unmatched    : hiçbir işe eşleşmeyen DSN/bounce postaları (K4). Ayrı raporlanır ve ORANIN PAYINA eklenir
 *                   (muhafazakâr: eşleşemeyen bir DSN yine de bizim gönderimimize ait olabilir).
 *  - bounceRate   : (bounced24h + unmatched) / sent24h ; sent24h < 10 iken kill-switch bu oranı DEĞERLENDİRMEZ.
 *  Semantik: bounce = alıcı sunucu teslim edemedi; complaint = alıcı spam bildirdi; reject = sağlayıcı kabul etmedi.
 *  Üçü de alıcıyı engelleme listesine alır ve orana eşit ağırlıkla girer.
 */
export interface HealthSnapshot { sent24h: number; bounced24h: number; unmatchedBounces24h: number; bounceRate: number; consecutiveErrors: number; dayCount: number; hourCount: number }

export async function emailHealthSnapshot(db: Queryable, provider: string): Promise<HealthSnapshot> {
  const s = await db.query(
    `WITH w AS (SELECT send_job_id, event FROM send_events WHERE occurred_at > now() - interval '24 hours'),
          attempted AS (SELECT DISTINCT send_job_id FROM w WHERE event IN ('accepted','reject')),
          bad AS (SELECT DISTINCT send_job_id FROM w WHERE event IN ('bounce','complaint','reject') AND send_job_id IN (SELECT send_job_id FROM attempted))
     SELECT (SELECT COUNT(*) FROM attempted) AS sent, (SELECT COUNT(*) FROM bad) AS bounced`
  );
  const sent = Number(s.rows[0].sent);
  const unmatched = Number((await db.query(`SELECT COUNT(*) n FROM inbound_messages WHERE classification = 'bounce' AND matched_send_job_id IS NULL AND received_at > now() - interval '24 hours'`)).rows[0].n);
  const bounced = Number(s.rows[0].bounced);
  const last = await db.query(`SELECT event FROM send_events WHERE event IN ('accepted','error','dry_run') ORDER BY occurred_at DESC LIMIT 10`);
  let consecutiveErrors = 0;
  for (const r of last.rows) { if (r.event === 'error') consecutiveErrors++; else break; }
  const q = await db.query(`SELECT bucket, sent_count FROM email_quota_usage WHERE provider = $1 AND bucket IN ($2,$3)`, [provider, dayBucket(), hourBucket()]);
  const dayCount = Number(q.rows.find((r) => r.bucket === dayBucket())?.sent_count ?? 0);
  const hourCount = Number(q.rows.find((r) => r.bucket === hourBucket())?.sent_count ?? 0);
  return { sent24h: sent, bounced24h: bounced, unmatchedBounces24h: unmatched, bounceRate: sent > 0 ? (bounced + unmatched) / sent : 0, consecutiveErrors, dayCount, hourCount };
}

/** Eşik aşımlarında gönderimi durdurur; durdurulduysa nedeni döndürür. */
export async function evaluateKillSwitch(db: Queryable, cfg: Config, opts: { fetchFn?: typeof fetch } = {}): Promise<{ paused: boolean; reason: string | null; snapshot: HealthSnapshot }> {
  const snap = await emailHealthSnapshot(db, cfg.EMAIL_PROVIDER);
  let reason: string | null = null;
  if (snap.sent24h >= 10 && snap.bounceRate > cfg.EMAIL_MAX_BOUNCE_RATE) reason = `Bounce oranı ${(snap.bounceRate * 100).toFixed(1)}% > ${(cfg.EMAIL_MAX_BOUNCE_RATE * 100).toFixed(1)}% (${snap.bounced24h} eşleşen + ${snap.unmatchedBounces24h} eşleşmeyen / ${snap.sent24h} gönderim)`;
  else if (snap.consecutiveErrors >= cfg.EMAIL_MAX_CONSECUTIVE_ERRORS) reason = `Ardışık ${snap.consecutiveErrors} gönderim hatası`;
  else if (snap.dayCount >= cfg.EMAIL_DAILY_QUOTA) reason = `Günlük kota doldu (${snap.dayCount}/${cfg.EMAIL_DAILY_QUOTA})`;
  if (reason) {
    const before = await isOutreachPaused(db);
    await setOutreachPaused(db, true, reason, 'killswitch');
    // Ö8: yalnız durum değişiminde (açık → durdu) bildirim; tekrar değerlendirmelerde spam yok
    if (!before.paused) await notifyAdmin(db, cfg, { kind: 'kill_switch', title: 'Gönderim otomatik olarak durduruldu', body: `${reason}. Panel → Sistem sayfasından inceleyip sürdürün.`, detail: snap }, opts.fetchFn);
    return { paused: true, reason, snapshot: snap };
  }
  return { paused: false, reason: null, snapshot: snap };
}

/** Saatlik/günlük kota içinde mi? İçindeyse sayacı artırır (atomik). */
export async function reserveQuota(db: Queryable, cfg: Config): Promise<{ ok: boolean; reason?: string }> {
  const r = await db.query(
    `WITH d AS (
       INSERT INTO email_quota_usage(bucket, provider, sent_count) VALUES ($1,$3,1)
       ON CONFLICT (bucket, provider) DO UPDATE SET sent_count = email_quota_usage.sent_count + 1 RETURNING sent_count),
     h AS (
       INSERT INTO email_quota_usage(bucket, provider, sent_count) VALUES ($2,$3,1)
       ON CONFLICT (bucket, provider) DO UPDATE SET sent_count = email_quota_usage.sent_count + 1 RETURNING sent_count)
     SELECT d.sent_count AS day, h.sent_count AS hour FROM d, h`,
    [dayBucket(), hourBucket(), cfg.EMAIL_PROVIDER]
  );
  const day = Number(r.rows[0].day);
  const hour = Number(r.rows[0].hour);
  if (day > cfg.EMAIL_DAILY_QUOTA) return { ok: false, reason: `Günlük kota aşıldı (${day}/${cfg.EMAIL_DAILY_QUOTA})` };
  if (hour > cfg.EMAIL_HOURLY_QUOTA) return { ok: false, reason: `Saatlik kota aşıldı (${hour}/${cfg.EMAIL_HOURLY_QUOTA})` };
  return { ok: true };
}
