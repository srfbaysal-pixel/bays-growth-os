import type pg from 'pg';
import type { AiProvider } from '../ai/types.js';
import { sha256 } from '../lib/crypto.js';
import { normalizeEmail, emailDomain } from '../lib/normalize.js';
import { suppressBusinessEverywhere } from '../outreach/policy.js';
import { ensureDeal, moveDealStage } from '../sales/deals.js';
import { createTask } from '../sales/tasks.js';
import { audit } from '../audit.js';

export interface InboundEmail {
  channel?: 'email' | 'whatsapp';
  provider_message_id?: string | null;
  from: string;
  to?: string | null;
  subject?: string | null;
  text: string;
  in_reply_to?: string | null;
  references?: string | null;
  received_at?: string | null;
  headers?: Record<string, unknown> | null;
}

export interface InboundResult { inbound_id: string; duplicate: boolean; matched: boolean; match_method: string; classification: string; business_id: string | null }

export function extractReplyToken(to: string | null | undefined, headers?: Record<string, unknown> | null): string | null {
  const candidates = [to ?? '', String(headers?.['delivered-to'] ?? ''), String(headers?.['x-original-to'] ?? '')];
  for (const c of candidates) {
    const m = /reply\+([A-Za-z0-9_-]{8,})@/i.exec(c);
    if (m) return m[1];
  }
  return null;
}

export function parseAddress(raw: string): string | null {
  const m = /<([^>]+)>/.exec(raw);
  return normalizeEmail(m ? m[1] : raw);
}

/** Gelen mesajı kaydeder, işletmeyle eşler, sınıflandırır ve satış aksiyonlarını üretir. İdempotent. */
export async function processInbound(db: pg.Pool | pg.PoolClient, ai: AiProvider, msg: InboundEmail): Promise<InboundResult> {
  const from = parseAddress(msg.from) ?? msg.from.toLowerCase();
  const dedup = sha256(`${msg.provider_message_id ?? ''}|${from}|${msg.subject ?? ''}|${msg.text.slice(0, 2000)}|${msg.received_at ?? ''}`);
  const existing = (await db.query('SELECT id, matched_business_id, classification, match_method FROM inbound_messages WHERE dedup_hash = $1', [dedup])).rows[0];
  if (existing) return { inbound_id: existing.id, duplicate: true, matched: Boolean(existing.matched_business_id), match_method: existing.match_method ?? 'none', classification: existing.classification ?? 'unknown', business_id: existing.matched_business_id };

  // Eşleştirme
  let job: any = null;
  let method = 'none';
  const token = extractReplyToken(msg.to, msg.headers);
  if (token) { job = (await db.query('SELECT id, business_id, contact_id, to_address FROM send_jobs WHERE reply_token = $1', [token])).rows[0]; if (job) method = 'reply_token'; }
  if (!job) {
    const ids = `${msg.in_reply_to ?? ''} ${msg.references ?? ''}`.match(/<[^>]+>/g) ?? [];
    if (ids.length) { job = (await db.query('SELECT id, business_id, contact_id, to_address FROM send_jobs WHERE message_id = ANY($1)', [ids])).rows[0]; if (job) method = 'message_id'; }
  }
  let businessId: string | null = job?.business_id ?? null;
  let contactId: string | null = job?.contact_id ?? null;
  if (!businessId) {
    const c = (await db.query('SELECT id, business_id FROM contacts WHERE email_normalized = $1 ORDER BY created_at LIMIT 1', [from])).rows[0];
    if (c) { businessId = c.business_id; contactId = c.id; method = 'contact_email'; }
  }
  if (!businessId) {
    const b = (await db.query('SELECT id FROM businesses WHERE email_public = $1 LIMIT 1', [from])).rows[0];
    if (b) { businessId = b.id; method = 'business_email'; }
  }
  if (!businessId) {
    const dom = emailDomain(from);
    if (dom && !/(gmail|hotmail|outlook|yahoo|icloud|yandex|mail)\./.test(dom)) {
      const b = (await db.query('SELECT id FROM businesses WHERE domain = $1 LIMIT 1', [dom])).rows[0];
      if (b) { businessId = b.id; method = 'domain'; }
    }
  }

  const cls = await ai.classify({ subject: msg.subject, body: msg.text }).catch(() => ({ classification: 'unknown' as const, confidence: 0, summary: 'hata' }));
  const needsReview = !businessId || cls.confidence < 0.7 || cls.classification === 'unknown' || cls.classification === 'question';

  const ins = await db.query(
    `INSERT INTO inbound_messages(channel, provider_message_id, dedup_hash, from_address, to_address, subject, body_text, in_reply_to, references_header, reply_token, matched_business_id, matched_contact_id, matched_send_job_id, match_method, classification, classification_confidence, classified_by, needs_human_review, received_at, processed_at, raw_headers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19::timestamptz, now()),now(),$20) RETURNING id`,
    [msg.channel ?? 'email', msg.provider_message_id ?? null, dedup, from, msg.to ?? null, msg.subject ?? null, msg.text, msg.in_reply_to ?? null, msg.references ?? null, token, businessId, contactId, job?.id ?? null, method, cls.classification, cls.confidence, ai.key === 'mock' ? 'rules' : 'llm', needsReview, msg.received_at ?? null, msg.headers ? JSON.stringify(msg.headers) : null]
  );
  const inboundId = ins.rows[0].id as string;
  if (job) await db.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'replied',$2)`, [job.id, JSON.stringify({ inbound_id: inboundId, classification: cls.classification })]);

  if (businessId) {
    await db.query(`UPDATE businesses SET status = 'replied' WHERE id = $1 AND status IN ('qualified','contacted')`, [businessId]);
    switch (cls.classification) {
      case 'rejected':
        await suppressBusinessEverywhere(db, businessId, 'Yanıt: ret', 'reply');
        await moveDealStage(db, businessId, 'lost', 'Yanıt: ret');
        break;
      case 'interested':
        await ensureDeal(db, businessId, { stage: 'interested', source: 'reply' });
        await createTask(db, { business_id: businessId, kind: 'follow_up', channel: 'email', title: 'İlgi yanıtı — takip et', description: cls.summary, due_at: new Date(Date.now() + 24 * 3600e3), dedup_key: `follow_up:${inboundId}` });
        break;
      case 'meeting_request':
        await ensureDeal(db, businessId, { stage: 'meeting', source: 'reply' });
        await createTask(db, { business_id: businessId, kind: 'meeting', channel: 'email', title: 'Görüşme talebi — zaman planla', description: cls.summary, due_at: new Date(Date.now() + 4 * 3600e3), dedup_key: `meeting:${inboundId}` });
        break;
      case 'question':
        await ensureDeal(db, businessId, { stage: 'interested', source: 'reply' });
        await createTask(db, { business_id: businessId, kind: 'review_reply', channel: 'email', title: 'Soru geldi — yanıtla', description: cls.summary, due_at: new Date(Date.now() + 8 * 3600e3), dedup_key: `question:${inboundId}` });
        break;
      case 'bounce':
        if (job) { await db.query(`UPDATE send_jobs SET status = 'bounced' WHERE id = $1`, [job.id]); await db.query(`INSERT INTO send_events(send_job_id, event, detail) VALUES ($1,'bounce',$2)`, [job.id, JSON.stringify({ inbound_id: inboundId })]); }
        await db.query(`INSERT INTO suppressions(kind, value, reason, source) VALUES ('email', $1, 'bounce', 'bounce') ON CONFLICT DO NOTHING`, [job?.to_address ?? from]);
        break;
      case 'out_of_office':
        await createTask(db, { business_id: businessId, kind: 'follow_up', channel: 'email', title: 'Ofis dışı — 7 gün sonra tekrar', description: cls.summary, due_at: new Date(Date.now() + 7 * 86400e3), dedup_key: `ooo:${inboundId}` });
        break;
      default:
        await createTask(db, { business_id: businessId, kind: 'review_reply', channel: 'email', title: 'Sınıflandırılamayan yanıt — incele', description: cls.summary, dedup_key: `review:${inboundId}` });
    }
  } else {
    await createTask(db, { kind: 'review_reply', channel: 'email', title: `Eşleşmeyen gelen e-posta: ${from}`, description: (msg.subject ?? '') + '\n' + msg.text.slice(0, 500), dedup_key: `unmatched:${inboundId}` });
  }
  await audit(db, { actorType: 'system', action: 'inbound_processed', entityType: 'inbound_message', entityId: inboundId, after: { method, classification: cls.classification, business_id: businessId } });
  return { inbound_id: inboundId, duplicate: false, matched: Boolean(businessId), match_method: method, classification: cls.classification, business_id: businessId };
}
