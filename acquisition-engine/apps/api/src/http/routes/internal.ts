import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireN8n } from '../plugins.js';
import { runWf1 } from '../../workflows/wf1.js';
import { runWf2Prepare, runWf2Send } from '../../workflows/wf2.js';
import { runWf3Inbound, runWf3Metrics } from '../../workflows/wf3.js';
import { heartbeat } from '../../health/status.js';
import { recordDeliveryEvent } from '../../outreach/sender.js';
import { hmacSha256, safeEqual } from '../../lib/crypto.js';
import { createHmac } from 'node:crypto';
import { unauthorized } from '../../lib/errors.js';

/**
 * n8n'in çağırdığı iç uçlar. Hepsi HMAC imzalı. Hiçbiri panel oturumuyla çağrılamaz.
 * Her çağrı run_id ile idempotent: aynı run_id ile ikinci çağrı önceki sonucu döndürür.
 */
export function internalRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = requireN8n(ctx);
  const runOnce = async <T>(key: string, runId: string, fn: () => Promise<T>): Promise<T | { already_ran: true; stats: unknown }> => {
    const prev = (await ctx.pool.query('SELECT status, stats FROM workflow_runs WHERE run_id = $1', [runId])).rows[0];
    if (prev && prev.status !== 'running') return { already_ran: true, stats: prev.stats };
    void key;
    return fn();
  };

  app.post('/internal/wf1/run', { preHandler: guard }, async (req) => {
    const body = z.object({ run_id: z.string().min(4).max(100), sector_key: z.string(), city: z.string().min(2).max(60), limit_per_query: z.number().int().min(1).max(20).optional(), target_qualified: z.number().int().min(1).max(200).optional() }).parse(req.body);
    return runOnce('wf1', body.run_id, () => runWf1(ctx.pool, ctx.cfg, { discovery: ctx.discovery, ai: ctx.ai, fetchFn: ctx.fetchFn, lookup: ctx.lookup }, { sectorKey: body.sector_key, city: body.city, limitPerQuery: body.limit_per_query, targetQualified: body.target_qualified, runId: body.run_id }));
  });

  app.post('/internal/wf2/prepare', { preHandler: guard }, async (req) => {
    const body = z.object({ run_id: z.string().min(4).max(100), limit: z.number().int().min(1).max(100).optional(), sector_key: z.string().nullable().optional() }).parse(req.body);
    return runOnce('wf2', body.run_id, () => runWf2Prepare(ctx.pool, ctx.cfg, ctx.ai, { runId: body.run_id, limit: body.limit, sectorKey: body.sector_key ?? null }));
  });

  app.post('/internal/wf2/send', { preHandler: guard }, async (req) => {
    const body = z.object({ run_id: z.string().min(4).max(100), limit: z.number().int().min(1).max(50).optional() }).parse(req.body);
    return runOnce('wf2s', body.run_id, () => runWf2Send(ctx.pool, ctx.cfg, ctx.email, { runId: body.run_id, limit: body.limit }));
  });

  app.post('/internal/wf3/inbound', { preHandler: guard }, async (req) => {
    const body = z.object({
      run_id: z.string().min(4).max(100),
      messages: z.array(z.object({ provider_message_id: z.string().nullable().optional(), from: z.string().min(3), to: z.string().nullable().optional(), subject: z.string().nullable().optional(), text: z.string().default(''), in_reply_to: z.string().nullable().optional(), references: z.string().nullable().optional(), received_at: z.string().nullable().optional(), headers: z.record(z.string(), z.unknown()).nullable().optional() })).max(200)
    }).parse(req.body);
    return runWf3Inbound(ctx.pool, ctx.ai, { runId: body.run_id, messages: body.messages, replyDomain: ctx.cfg.EMAIL_REPLY_DOMAIN });
  });

  app.post('/internal/wf3/metrics', { preHandler: guard }, async (req) => {
    const body = z.object({ run_id: z.string().min(4).max(100), day: z.string().date().optional(), weekly: z.boolean().optional() }).parse(req.body);
    return runWf3Metrics(ctx.pool, { runId: body.run_id, day: body.day, weekly: body.weekly });
  });

  app.post('/internal/heartbeat', { preHandler: guard }, async (req) => {
    const body = z.object({ workflow_key: z.string().max(50), run_id: z.string().max(100), status: z.enum(['running', 'succeeded', 'failed', 'partial']), stats: z.unknown().optional(), error: z.string().max(2000).nullable().optional() }).parse(req.body);
    await heartbeat(ctx.pool, body.workflow_key, body.run_id, body.status, body.stats, body.error ?? null);
    return { ok: true };
  });

  /** Resend teslimat webhook'u (svix imzası). Belge: https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests */
  app.post('/webhooks/email/resend', async (req, reply) => {
    const secret = ctx.cfg.RESEND_WEBHOOK_SECRET;
    if (!secret) return reply.status(404).send({ error: 'disabled' });
    const id = String(req.headers['svix-id'] ?? '');
    const ts = String(req.headers['svix-timestamp'] ?? '');
    const sigs = String(req.headers['svix-signature'] ?? '');
    const raw = req.rawBodyText ?? '';
    if (!id || !ts || !sigs || Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw unauthorized('svix başlıkları eksik');
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
    const ok = sigs.split(' ').some((s) => { const [, v] = s.split(','); return v && safeEqual(v, expected); });
    if (!ok) throw unauthorized('svix imzası geçersiz');
    const ev = req.body as any;
    const dup = await ctx.pool.query(`INSERT INTO webhook_events(source, event_id, payload) VALUES ('resend', $1, $2) ON CONFLICT DO NOTHING RETURNING id`, [id, JSON.stringify(ev)]);
    if ((dup.rowCount ?? 0) === 0) return { ok: true, duplicate: true };
    const map: Record<string, 'delivered' | 'bounce' | 'complaint'> = { 'email.delivered': 'delivered', 'email.bounced': 'bounce', 'email.complained': 'complaint' };
    const kind = map[ev.type];
    if (kind) await recordDeliveryEvent(ctx.pool, { providerMessageId: ev.data?.email_id, event: kind, providerEventId: id, detail: ev.data });
    return { ok: true };
  });

  /** Genel sağlayıcı/IMAP köprüsü: n8n'den imzalı teslimat olayı */
  app.post('/internal/email/delivery-event', { preHandler: guard }, async (req) => {
    const body = z.object({ provider_message_id: z.string().nullable().optional(), message_id: z.string().nullable().optional(), event: z.enum(['delivered', 'bounce', 'complaint', 'reject']), provider_event_id: z.string().nullable().optional(), detail: z.unknown().optional() }).parse(req.body);
    return recordDeliveryEvent(ctx.pool, { providerMessageId: body.provider_message_id, messageId: body.message_id, event: body.event, providerEventId: body.provider_event_id, detail: body.detail });
  });

  /** WhatsApp Cloud API webhook doğrulama + imzalı olay alma (yalnız loglanır; otomatik yanıt yok) */
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (ctx.cfg.WHATSAPP_VERIFY_TOKEN && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === ctx.cfg.WHATSAPP_VERIFY_TOKEN) return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    return reply.status(403).send('forbidden');
  });
  app.post('/webhooks/whatsapp', async (req, reply) => {
    if (!ctx.cfg.WHATSAPP_APP_SECRET) return reply.status(404).send({ error: 'disabled' });
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = 'sha256=' + hmacSha256(ctx.cfg.WHATSAPP_APP_SECRET, req.rawBodyText ?? '');
    if (!safeEqual(sig, expected)) throw unauthorized('WhatsApp imzası geçersiz');
    const ev = req.body as any;
    const eid = ev?.entry?.[0]?.id + ':' + (ev?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id ?? ev?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.id ?? Date.now());
    await ctx.pool.query(`INSERT INTO webhook_events(source, event_id, payload) VALUES ('whatsapp', $1, $2) ON CONFLICT DO NOTHING`, [eid, JSON.stringify(ev)]);
    const msgs = ev?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
    for (const m of msgs) {
      if (m.type === 'text' && m.from) {
        await runWf3Inbound(ctx.pool, ctx.ai, { runId: `wa:${m.id}`, messages: [{ channel: 'whatsapp', provider_message_id: m.id, from: `+${m.from}`, text: m.text?.body ?? '', received_at: new Date(Number(m.timestamp) * 1000).toISOString() } as any] });
      }
    }
    return { ok: true };
  });
}
