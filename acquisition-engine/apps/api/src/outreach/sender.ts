import type pg from 'pg';
import type { Config } from '../config.js';
import type { EmailProvider } from '../email/types.js';
import { withTx } from '../db/pool.js';
import { decidePolicy, isOutreachPaused, isSuppressed } from './policy.js';
import { evaluateKillSwitch, reserveQuota } from './killswitch.js';
import { audit } from '../audit.js';
import { log } from '../lib/logger.js';

export interface SenderStats { picked: number; sent: number; dry_run: number; failed: number; blocked: number; retried: number; paused: boolean; pause_reason: string | null }

const BACKOFF_MIN = [2, 10, 30];

/**
 * Kuyruktaki e-posta işlerini işler. Her iş:
 *  1) FOR UPDATE SKIP LOCKED ile kilitlenir (çift gönderim yok),
 *  2) politika ve engelleme yeniden kontrol edilir,
 *  3) kota rezerve edilir,
 *  4) DRY_RUN ise gönderilmez, dry_run olayı yazılır,
 *  5) sağlayıcıya gönderilir; hata → üstel bekleme ile yeniden dener, limit sonrası failed.
 * Aynı iş için sağlayıcıya ikinci istek yalnız "accepted" dönmemişse yapılır; idempotency anahtarı iş kimliğidir.
 */
export async function processSendQueue(pool: pg.Pool, cfg: Config, provider: EmailProvider, limit = 10): Promise<SenderStats> {
  const stats: SenderStats = { picked: 0, sent: 0, dry_run: 0, failed: 0, blocked: 0, retried: 0, paused: false, pause_reason: null };
  const ks = await evaluateKillSwitch(pool, cfg);
  if (ks.paused) { stats.paused = true; stats.pause_reason = ks.reason; return stats; }
  const paused = await isOutreachPaused(pool);
  if (paused.paused) { stats.paused = true; stats.pause_reason = paused.reason; return stats; }

  for (let i = 0; i < limit; i++) {
    const job = await withTx(async (c) => {
      const r = await c.query(
        `SELECT j.*, d.subject, d.body, d.contact_id AS d_contact_id, b.sector_key, b.name AS business_name, b.domain, b.phone_e164, b.instagram_handle, b.status AS business_status
           FROM send_jobs j JOIN message_drafts d ON d.id = j.draft_id JOIN businesses b ON b.id = j.business_id
          WHERE j.status = 'queued' AND j.next_attempt_at <= now() AND j.channel = 'email'
          ORDER BY j.next_attempt_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`
      );
      const row = r.rows[0];
      if (!row) return null;
      await c.query(`UPDATE send_jobs SET status = 'sending', locked_at = now(), attempts = attempts + 1 WHERE id = $1`, [row.id]);
      await c.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'attempt',$2)`, [row.id, JSON.stringify({ attempt: row.attempts + 1 })]);
      return row;
    }, pool);
    if (!job) break;
    stats.picked++;

    const perm = (await pool.query(`SELECT status FROM channel_permissions WHERE business_id = $1 AND channel = 'email' LIMIT 1`, [job.business_id])).rows[0]?.status ?? 'unknown';
    const policy = decidePolicy({
      cfg, channel: 'email', sectorKey: job.sector_key,
      business: { id: job.business_id, domain: job.domain, phone_e164: job.phone_e164, instagram_handle: job.instagram_handle, status: job.business_status },
      toAddress: job.to_address, permissionStatus: perm,
      suppressed: await isSuppressed(pool, { id: job.business_id, domain: job.domain, phone_e164: job.phone_e164, instagram_handle: job.instagram_handle }, job.to_address),
      outreachPaused: false
    });
    if (policy.mode !== 'auto_send') {
      await pool.query(`UPDATE send_jobs SET status = 'blocked', last_error = $2 WHERE id = $1`, [job.id, policy.reasons.join('; ')]);
      await pool.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'blocked',$2)`, [job.id, JSON.stringify(policy)]);
      await pool.query(`UPDATE message_drafts SET status = 'blocked' WHERE id = $1`, [job.draft_id]);
      stats.blocked++;
      continue;
    }

    const quota = await reserveQuota(pool, cfg);
    if (!quota.ok) {
      await pool.query(`UPDATE send_jobs SET status = 'queued', next_attempt_at = now() + interval '1 hour', attempts = attempts - 1 WHERE id = $1`, [job.id]);
      await pool.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'blocked',$2)`, [job.id, JSON.stringify({ quota: quota.reason })]);
      stats.blocked++;
      break;
    }

    const messageId = `<${job.id}@${cfg.EMAIL_REPLY_DOMAIN}>`;
    const replyTo = `reply+${job.reply_token}@${cfg.EMAIL_REPLY_DOMAIN}`;
    if (cfg.DRY_RUN) {
      await pool.query(`UPDATE send_jobs SET status = 'dry_run', message_id = $2, provider = $3, sent_at = now() WHERE id = $1`, [job.id, messageId, 'dry_run']);
      await pool.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'dry_run',$2)`, [job.id, JSON.stringify({ to: job.to_address, subject: job.subject, reply_to: replyTo })]);
      await pool.query(`UPDATE message_drafts SET status = 'sent' WHERE id = $1`, [job.draft_id]);
      await pool.query(`UPDATE businesses SET status = 'contacted' WHERE id = $1 AND status IN ('qualified')`, [job.business_id]);
      stats.dry_run++;
      log.info('dry_run gönderim', { job: job.id, to: job.to_address });
      continue;
    }

    try {
      const res = await provider.send({
        to: job.to_address, from: { name: cfg.EMAIL_FROM_NAME, address: cfg.EMAIL_FROM_ADDRESS }, replyTo,
        subject: job.subject ?? '', text: job.body, messageId, idempotencyKey: job.id
      });
      if (!res.accepted) throw new Error('Sağlayıcı kabul etmedi: ' + JSON.stringify(res.detail ?? {}).slice(0, 200));
      await pool.query(`UPDATE send_jobs SET status = 'accepted', message_id = $2, provider = $3, provider_message_id = $4, sent_at = now(), last_error = NULL WHERE id = $1`, [job.id, messageId, provider.key, res.providerMessageId ?? null]);
      await pool.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'accepted',$2)`, [job.id, JSON.stringify({ provider_message_id: res.providerMessageId ?? null })]);
      await pool.query(`UPDATE message_drafts SET status = 'sent' WHERE id = $1`, [job.draft_id]);
      await pool.query(`UPDATE businesses SET status = 'contacted' WHERE id = $1 AND status IN ('qualified')`, [job.business_id]);
      await audit(pool, { actorType: 'system', action: 'email_sent', entityType: 'send_job', entityId: job.id, after: { to: job.to_address, provider: provider.key } });
      stats.sent++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      const attempts = Number(job.attempts) + 1;
      await pool.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'error',$2)`, [job.id, JSON.stringify({ error: msg, attempt: attempts })]);
      if (attempts >= Number(job.max_attempts)) {
        await pool.query(`UPDATE send_jobs SET status = 'failed', last_error = $2 WHERE id = $1`, [job.id, msg]);
        stats.failed++;
      } else {
        const mins = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
        await pool.query(`UPDATE send_jobs SET status = 'queued', last_error = $2, next_attempt_at = now() + ($3 || ' minutes')::interval WHERE id = $1`, [job.id, msg, String(mins)]);
        stats.retried++;
      }
      // Kill-switch'i her hatadan sonra yeniden değerlendir
      const ks2 = await evaluateKillSwitch(pool, cfg);
      if (ks2.paused) { stats.paused = true; stats.pause_reason = ks2.reason; break; }
    }
  }
  return stats;
}

/** Sağlayıcı webhook'larından (bounce/delivered/complaint) gelen olayları işler. */
export async function recordDeliveryEvent(db: pg.Pool | pg.PoolClient, e: { providerMessageId?: string | null; messageId?: string | null; event: 'delivered' | 'bounce' | 'complaint' | 'reject'; providerEventId?: string | null; detail?: unknown }): Promise<{ matched: boolean; send_job_id?: string }> {
  const job = (await db.query(`SELECT id, business_id, to_address FROM send_jobs WHERE ($1::text IS NOT NULL AND provider_message_id = $1) OR ($2::text IS NOT NULL AND message_id = $2) LIMIT 1`, [e.providerMessageId ?? null, e.messageId ?? null])).rows[0];
  if (!job) return { matched: false };
  const ins = await db.query(`INSERT INTO send_events(send_job_id, event, detail, provider_event_id) VALUES ($1,$2,$3,$4) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`, [job.id, e.event, JSON.stringify(e.detail ?? {}), e.providerEventId ?? null]);
  if ((ins.rowCount ?? 0) === 0) return { matched: true, send_job_id: job.id }; // mükerrer olay
  if (e.event === 'delivered') await db.query(`UPDATE send_jobs SET status = 'delivered' WHERE id = $1 AND status = 'accepted'`, [job.id]);
  if (e.event === 'bounce' || e.event === 'complaint' || e.event === 'reject') {
    await db.query(`UPDATE send_jobs SET status = 'bounced', last_error = $2 WHERE id = $1`, [job.id, e.event]);
    await db.query(`INSERT INTO suppressions(kind, value, reason, source) VALUES ('email', $1, $2, $3) ON CONFLICT DO NOTHING`, [job.to_address.toLowerCase(), e.event, e.event === 'complaint' ? 'complaint' : 'bounce']);
  }
  return { matched: true, send_job_id: job.id };
}
