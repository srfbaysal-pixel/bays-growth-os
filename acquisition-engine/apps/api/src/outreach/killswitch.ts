import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import { dayBucket, hourBucket } from '../lib/normalize.js';
import { setOutreachPaused } from './policy.js';

export interface HealthSnapshot { sent24h: number; bounced24h: number; bounceRate: number; consecutiveErrors: number; dayCount: number; hourCount: number }

export async function emailHealthSnapshot(db: Queryable, provider: string): Promise<HealthSnapshot> {
  const s = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE event IN ('accepted','delivered')) AS sent,
       COUNT(*) FILTER (WHERE event IN ('bounce','complaint','reject')) AS bounced
     FROM send_events WHERE occurred_at > now() - interval '24 hours'`
  );
  const sent = Number(s.rows[0].sent);
  const bounced = Number(s.rows[0].bounced);
  const last = await db.query(`SELECT event FROM send_events WHERE event IN ('accepted','error','dry_run') ORDER BY occurred_at DESC LIMIT 10`);
  let consecutiveErrors = 0;
  for (const r of last.rows) { if (r.event === 'error') consecutiveErrors++; else break; }
  const q = await db.query(`SELECT bucket, sent_count FROM email_quota_usage WHERE provider = $1 AND bucket IN ($2,$3)`, [provider, dayBucket(), hourBucket()]);
  const dayCount = Number(q.rows.find((r) => r.bucket === dayBucket())?.sent_count ?? 0);
  const hourCount = Number(q.rows.find((r) => r.bucket === hourBucket())?.sent_count ?? 0);
  return { sent24h: sent, bounced24h: bounced, bounceRate: sent + bounced > 0 ? bounced / (sent + bounced) : 0, consecutiveErrors, dayCount, hourCount };
}

/** Eşik aşımlarında gönderimi durdurur; durdurulduysa nedeni döndürür. */
export async function evaluateKillSwitch(db: Queryable, cfg: Config): Promise<{ paused: boolean; reason: string | null; snapshot: HealthSnapshot }> {
  const snap = await emailHealthSnapshot(db, cfg.EMAIL_PROVIDER);
  let reason: string | null = null;
  if (snap.sent24h + snap.bounced24h >= 10 && snap.bounceRate > cfg.EMAIL_MAX_BOUNCE_RATE) reason = `Bounce oranı ${(snap.bounceRate * 100).toFixed(1)}% > ${(cfg.EMAIL_MAX_BOUNCE_RATE * 100).toFixed(1)}%`;
  else if (snap.consecutiveErrors >= cfg.EMAIL_MAX_CONSECUTIVE_ERRORS) reason = `Ardışık ${snap.consecutiveErrors} gönderim hatası`;
  else if (snap.dayCount >= cfg.EMAIL_DAILY_QUOTA) reason = `Günlük kota doldu (${snap.dayCount}/${cfg.EMAIL_DAILY_QUOTA})`;
  if (reason) {
    await setOutreachPaused(db, true, reason, 'killswitch');
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
