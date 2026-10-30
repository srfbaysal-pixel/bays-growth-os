import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import { audit } from '../audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { decidePolicy, isOutreachPaused, isSuppressed, type Channel } from './policy.js';
import { validateDraft } from './validate.js';
import { createTask } from '../sales/tasks.js';
import { ensureDeal } from '../sales/deals.js';

export interface Actor { id: string; ip?: string | null }

async function loadDraft(db: Queryable, id: string) {
  const d = (await db.query('SELECT * FROM message_drafts WHERE id = $1', [id])).rows[0];
  if (!d) throw notFound('Taslak bulunamadı');
  return d;
}

export async function editDraft(db: Queryable, id: string, actor: Actor, patch: { subject?: string | null; body?: string }): Promise<void> {
  const d = await loadDraft(db, id);
  if (d.status !== 'pending_approval') throw conflict('Yalnız onay bekleyen taslak düzenlenebilir');
  const b = (await db.query('SELECT name, city, sector_key FROM businesses WHERE id = $1', [d.business_id])).rows[0];
  const body = patch.body ?? d.body;
  const subject = patch.subject === undefined ? d.subject : patch.subject;
  const v = validateDraft({ subject, body, facts_used: d.facts_used ?? [] }, { sectorKey: b.sector_key, sectorName: '', channel: d.channel, business: { name: b.name, city: b.city }, serviceName: '', angle: '', facts: (await db.query('SELECT id, field, value FROM research_evidence WHERE business_id = $1', [d.business_id])).rows.map((e) => ({ ...e, label: '' })), restrictions: [], senderName: '' });
  if (!v.ok) throw badRequest('Düzenleme doğrulamadan geçmedi', v.errors);
  await db.query('UPDATE message_drafts SET subject = $2, body = $3, version = version + 1, validation = $4 WHERE id = $1', [id, subject, body, JSON.stringify(v)]);
  await db.query('INSERT INTO approval_actions(draft_id, user_id, action, diff) VALUES ($1,$2,$3,$4)', [id, actor.id, 'edit', JSON.stringify({ before: { subject: d.subject, body: d.body }, after: { subject, body } })]);
  await audit(db, { actorType: 'user', actorId: actor.id, action: 'draft_edit', entityType: 'message_draft', entityId: id, before: { body: d.body }, after: { body }, ip: actor.ip });
}

export async function rejectDraft(db: Queryable, id: string, actor: Actor, reason: string): Promise<void> {
  const d = await loadDraft(db, id);
  if (!['pending_approval', 'approved'].includes(d.status)) throw conflict('Bu taslak reddedilemez');
  await db.query(`UPDATE message_drafts SET status = 'rejected', rejected_reason = $2 WHERE id = $1`, [id, reason]);
  await db.query('INSERT INTO approval_actions(draft_id, user_id, action, note) VALUES ($1,$2,$3,$4)', [id, actor.id, 'reject', reason]);
  await audit(db, { actorType: 'user', actorId: actor.id, action: 'draft_reject', entityType: 'message_draft', entityId: id, after: { reason }, ip: actor.ip });
}

/**
 * Onay: politika yeniden değerlendirilir (onay anındaki bayraklar geçerlidir).
 * auto_send → send_jobs'a kuyruklanır (gönderim ayrı adımda, yine politika kontrolüyle).
 * manual_task → manuel iletişim görevi.
 */
export async function approveDraft(db: Queryable, cfg: Config, id: string, actor: Actor, note?: string): Promise<{ outcome: 'queued' | 'manual_task' | 'blocked'; reasons: string[] }> {
  const d = await loadDraft(db, id);
  if (d.status !== 'pending_approval') throw conflict(`Taslak onaylanamaz (durum: ${d.status})`);
  const b = (await db.query('SELECT * FROM businesses WHERE id = $1', [d.business_id])).rows[0];
  const contact = d.contact_id ? (await db.query('SELECT * FROM contacts WHERE id = $1', [d.contact_id])).rows[0] : null;
  const email = contact?.email_normalized ?? b.email_public ?? null;
  const channel = d.channel as Channel;
  const toAddress = channel === 'email' ? email : channel === 'whatsapp' ? (contact?.phone_e164 ?? b.phone_e164) : null;
  const perm = (await db.query(`SELECT status FROM channel_permissions WHERE business_id = $1 AND channel = $2 LIMIT 1`, [b.id, channel])).rows[0]?.status ?? 'unknown';
  const policy = decidePolicy({ cfg, channel, sectorKey: b.sector_key, business: b, toAddress, permissionStatus: perm, suppressed: await isSuppressed(db, b, email), outreachPaused: (await isOutreachPaused(db)).paused });

  await db.query('INSERT INTO approval_actions(draft_id, user_id, action, note) VALUES ($1,$2,$3,$4)', [id, actor.id, 'approve', note ?? null]);
  await ensureDeal(db, b.id, { stage: 'contacted', service_key: d.service_key, source: 'outreach' });

  if (policy.mode === 'blocked') {
    await db.query(`UPDATE message_drafts SET status = 'blocked', policy_decision = $2, approved_by = $3, approved_at = now() WHERE id = $1`, [id, JSON.stringify(policy), actor.id]);
    await audit(db, { actorType: 'user', actorId: actor.id, action: 'draft_approve_blocked', entityType: 'message_draft', entityId: id, after: policy, ip: actor.ip });
    return { outcome: 'blocked', reasons: policy.reasons };
  }
  if (policy.mode === 'manual_task') {
    await db.query(`UPDATE message_drafts SET status = 'manual_task', policy_decision = $2, approved_by = $3, approved_at = now() WHERE id = $1`, [id, JSON.stringify(policy), actor.id]);
    await createTask(db, {
      business_id: b.id, draft_id: id, kind: 'manual_outreach', channel,
      title: `${b.name} — ${channel} üzerinden manuel iletişim`,
      description: `Onaylı mesajı elle gönderin.\nNeden otomatik değil: ${policy.reasons.join('; ')}\n\n--- Mesaj ---\n${d.subject ? 'Konu: ' + d.subject + '\n' : ''}${d.body}`,
      dedup_key: `manual_outreach:${id}`, assigned_to: actor.id
    });
    await audit(db, { actorType: 'user', actorId: actor.id, action: 'draft_approve_manual', entityType: 'message_draft', entityId: id, after: policy, ip: actor.ip });
    return { outcome: 'manual_task', reasons: policy.reasons };
  }
  await db.query(`UPDATE message_drafts SET status = 'queued', policy_decision = $2, approved_by = $3, approved_at = now() WHERE id = $1`, [id, JSON.stringify(policy), actor.id]);
  await db.query(
    `INSERT INTO send_jobs(draft_id, business_id, contact_id, channel, to_address, reply_token) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (draft_id) DO NOTHING`,
    [id, b.id, contact?.id ?? null, channel, toAddress, randomToken(12)]
  );
  const job = (await db.query('SELECT id FROM send_jobs WHERE draft_id = $1', [id])).rows[0];
  await db.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'queued',$2)`, [job.id, JSON.stringify({ by: actor.id, test_mode: policy.test_mode })]);
  await audit(db, { actorType: 'user', actorId: actor.id, action: 'draft_approve_queued', entityType: 'message_draft', entityId: id, after: policy, ip: actor.ip });
  return { outcome: 'queued', reasons: policy.reasons };
}
