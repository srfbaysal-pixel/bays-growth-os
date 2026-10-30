import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireSameOrigin } from '../plugins.js';
import { setDealStage, STAGES } from '../../sales/deals.js';
import { completeTask, createTask } from '../../sales/tasks.js';
import { createQuote, setQuoteStatus } from '../../sales/quotes.js';
import { createReferralCampaign, updateReferralCampaign } from '../../sales/referral.js';
import { audit } from '../../audit.js';
import { notFound } from '../../lib/errors.js';
import { processInbound } from '../../inbound/process.js';

const uuid = z.string().uuid();

export function salesRoutes(app: FastifyInstance, ctx: AppContext) {
  const mut = [requireUser('operator'), requireSameOrigin(ctx.cfg)];

  app.get('/api/conversations', { preHandler: requireUser() }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const inbound = await ctx.pool.query(
      `SELECT i.id, i.from_address, i.subject, i.classification, i.classification_confidence, i.needs_human_review, i.received_at, i.match_method, i.body_text,
              b.id AS business_id, b.name AS business_name, b.sector_key
         FROM inbound_messages i LEFT JOIN businesses b ON b.id = i.matched_business_id ORDER BY i.received_at DESC LIMIT $1`, [q.limit]);
    const tasks = await ctx.pool.query(`SELECT t.*, b.name AS business_name FROM tasks t LEFT JOIN businesses b ON b.id = t.business_id WHERE t.status = 'open' ORDER BY t.due_at NULLS LAST, t.created_at LIMIT $1`, [q.limit]);
    const deals = await ctx.pool.query(`SELECT d.*, b.name AS business_name, b.sector_key, s.name AS service_name FROM deals d JOIN businesses b ON b.id = d.business_id LEFT JOIN services s ON s.key = d.service_key ORDER BY d.updated_at DESC LIMIT $1`, [q.limit]);
    const quotes = await ctx.pool.query(`SELECT q.*, b.name AS business_name FROM quotes q JOIN businesses b ON b.id = q.business_id ORDER BY q.created_at DESC LIMIT $1`, [q.limit]);
    return { inbound: inbound.rows, tasks: tasks.rows, deals: deals.rows, quotes: quotes.rows, stages: STAGES };
  });

  app.post('/api/deals/:id/stage', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ stage: z.enum(STAGES), value_cents: z.number().int().min(0).nullable().optional(), lost_reason: z.string().max(300).nullable().optional() }).parse(req.body);
    const before = (await ctx.pool.query('SELECT stage FROM deals WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    await setDealStage(ctx.pool, id, body.stage, body);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'deal_stage', entityType: 'deal', entityId: id, before, after: body, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/tasks', { preHandler: mut }, async (req) => {
    const body = z.object({ business_id: uuid.optional(), deal_id: uuid.optional(), kind: z.enum(['manual_outreach', 'follow_up', 'call', 'meeting', 'compliance_check', 'review_reply', 'other']), channel: z.string().max(20).optional(), title: z.string().min(2).max(200), description: z.string().max(5000).optional(), due_at: z.string().datetime().optional() }).parse(req.body);
    const id = await createTask(ctx.pool, { ...body, due_at: body.due_at ? new Date(body.due_at) : null, assigned_to: req.user!.id });
    return { id };
  });
  app.post('/api/tasks/:id/complete', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ status: z.enum(['done', 'cancelled']).default('done') }).parse(req.body ?? {});
    await completeTask(ctx.pool, id, body.status);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'task_' + body.status, entityType: 'task', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/quotes', { preHandler: mut }, async (req) => {
    const body = z.object({ deal_id: uuid, plan_id: uuid.nullable().optional(), setup_fee_cents: z.number().int().min(0).optional(), monthly_fee_cents: z.number().int().min(0).optional(), discount_pct: z.number().min(0).max(100).optional(), valid_until: z.string().date().nullable().optional(), notes: z.string().max(1000).nullable().optional() }).parse(req.body);
    const id = await createQuote(ctx.pool, body);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'quote_created', entityType: 'quote', entityId: id, after: body, ip: req.ip });
    return { id };
  });
  app.post('/api/quotes/:id/status', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ status: z.enum(['sent', 'accepted', 'rejected', 'expired']) }).parse(req.body);
    await setQuoteStatus(ctx.pool, id, body.status);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'quote_' + body.status, entityType: 'quote', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/revenue', { preHandler: requireUser() }, async () => {
    const subs = await ctx.pool.query(`SELECT s.*, b.name AS business_name, b.sector_key, sv.name AS service_name FROM subscriptions s JOIN businesses b ON b.id = s.business_id JOIN services sv ON sv.key = s.service_key ORDER BY s.status, s.started_at DESC`);
    const bySector = await ctx.pool.query(`SELECT b.sector_key, COUNT(*) FILTER (WHERE s.status IN ('active','trial'))::int AS active, COALESCE(SUM(s.monthly_fee_cents) FILTER (WHERE s.status IN ('active','trial')),0)::bigint AS mrr_cents,
        (SELECT COUNT(*)::int FROM businesses bb WHERE bb.sector_key = b.sector_key) AS leads,
        (SELECT COUNT(*)::int FROM deals d JOIN businesses bb ON bb.id = d.business_id WHERE bb.sector_key = b.sector_key AND d.stage = 'won') AS won
        FROM subscriptions s JOIN businesses b ON b.id = s.business_id GROUP BY b.sector_key`);
    const sectors = await ctx.pool.query(`SELECT s.key, s.name, (SELECT COUNT(*)::int FROM businesses b WHERE b.sector_key = s.key) AS leads, (SELECT COUNT(*)::int FROM businesses b WHERE b.sector_key = s.key AND b.status = 'qualified') AS qualified, (SELECT COUNT(*)::int FROM deals d JOIN businesses b ON b.id = d.business_id WHERE b.sector_key = s.key AND d.stage = 'won') AS won FROM sectors s WHERE s.is_active ORDER BY s.key`);
    const mrr = subs.rows.filter((s) => ['active', 'trial'].includes(s.status)).reduce((a, s) => a + Number(s.monthly_fee_cents), 0);
    const monthly = await ctx.pool.query(`SELECT to_char(date_trunc('month', started_at), 'YYYY-MM') AS month, COALESCE(SUM(setup_fee_cents),0)::bigint AS setup_cents, COUNT(*)::int AS new_subs FROM subscriptions GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);
    const referrals = await ctx.pool.query(`SELECT r.*, b.name AS business_name, b.sector_key FROM referral_campaigns r JOIN businesses b ON b.id = r.business_id ORDER BY r.updated_at DESC`);
    return { subscriptions: subs.rows, mrr_cents: mrr, by_sector: bySector.rows, sectors: sectors.rows, monthly: monthly.rows, referrals: referrals.rows };
  });

  app.post('/api/referrals', { preHandler: mut }, async (req) => {
    const body = z.object({ business_id: uuid, subscription_id: uuid.nullable().optional(), logo_url: z.string().url().nullable().optional(), brand_info: z.record(z.string(), z.unknown()).optional(), video_template: z.string().max(100).nullable().optional() }).parse(req.body);
    const id = await createReferralCampaign(ctx.pool, body);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'referral_created', entityType: 'referral_campaign', entityId: id, ip: req.ip });
    return { id };
  });
  app.patch('/api/referrals/:id', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({
      video_status: z.enum(['not_started', 'brief_ready', 'in_production', 'uploaded', 'customer_review', 'approved', 'published']).optional(),
      video_url: z.string().url().nullable().optional(), customer_approval_status: z.enum(['pending', 'approved', 'rejected']).optional(),
      share_url: z.string().url().nullable().optional(), share_verified: z.boolean().optional(), repost_permission: z.boolean().optional(),
      compliance_status: z.enum(['not_required', 'pending', 'approved', 'rejected']).optional(), accounting_status: z.enum(['none', 'credited', 'invoiced']).optional(),
      discount_status: z.enum(['pending', 'eligible', 'applied', 'void']).optional(), notes: z.string().max(2000).nullable().optional()
    }).parse(req.body);
    const out = await updateReferralCampaign(ctx.pool, id, { ...body, share_verified_by: body.share_verified ? req.user!.id : undefined });
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'referral_updated', entityType: 'referral_campaign', entityId: id, after: body, ip: req.ip });
    return out;
  });

  /** Panelden manuel yanıt girişi (IMAP bağlı değilken) */
  app.post('/api/inbound/manual', { preHandler: mut }, async (req) => {
    const body = z.object({ from: z.string().min(3).max(300), subject: z.string().max(300).optional(), text: z.string().min(1).max(20000), business_id: uuid.optional() }).parse(req.body);
    const res = await processInbound(ctx.pool, ctx.ai, { ...body, channel: 'email', provider_message_id: null, received_at: new Date().toISOString() }, { replyDomain: ctx.cfg.EMAIL_REPLY_DOMAIN });
    if (body.business_id && !res.matched) await ctx.pool.query('UPDATE inbound_messages SET matched_business_id = $2, match_method = $3 WHERE id = $1', [res.inbound_id, body.business_id, 'manual']);
    return res;
  });
}
