import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireSameOrigin } from '../plugins.js';
import { approveDraft, editDraft, rejectDraft } from '../../outreach/approvals.js';
import { notFound } from '../../lib/errors.js';

const uuid = z.string().uuid();

export function approvalRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/approvals', { preHandler: requireUser() }, async (req) => {
    const q = z.object({ status: z.string().default('pending_approval'), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const rows = await ctx.pool.query(
      `SELECT d.id, d.channel, d.status, d.subject, d.body, d.generator, d.validation, d.policy_decision, d.facts_used, d.service_key, d.created_at, d.version,
              b.id AS business_id, b.name AS business_name, b.sector_key, b.city, b.lead_score, s.name AS service_name,
              COALESCE(c.email_normalized, b.email_public) AS to_email
         FROM message_drafts d JOIN businesses b ON b.id = d.business_id LEFT JOIN services s ON s.key = d.service_key LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE d.status = $1 ORDER BY b.lead_score DESC, d.created_at LIMIT $2`,
      [q.status, q.limit]
    );
    return { items: rows.rows };
  });

  app.get('/api/approvals/:id', { preHandler: requireUser() }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const d = (await ctx.pool.query(`SELECT d.*, b.name AS business_name, b.sector_key, b.city FROM message_drafts d JOIN businesses b ON b.id = d.business_id WHERE d.id = $1`, [id])).rows[0];
    if (!d) throw notFound();
    const facts = (await ctx.pool.query('SELECT id, field, value, source_key, kind, evidence_url FROM research_evidence WHERE id = ANY($1::uuid[])', [d.facts_used ?? []])).rows;
    const actions = (await ctx.pool.query('SELECT a.action, a.note, a.created_at, u.email FROM approval_actions a JOIN users u ON u.id = a.user_id WHERE a.draft_id = $1 ORDER BY a.created_at', [id])).rows;
    return { draft: d, facts, actions };
  });

  const mut = [requireUser('operator'), requireSameOrigin(ctx.cfg)];
  app.post('/api/approvals/:id/approve', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    return approveDraft(ctx.pool, ctx.cfg, id, { id: req.user!.id, ip: req.ip }, body.note);
  });
  app.post('/api/approvals/:id/reject', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ reason: z.string().min(2).max(500) }).parse(req.body);
    await rejectDraft(ctx.pool, id, { id: req.user!.id, ip: req.ip }, body.reason);
    return { ok: true };
  });
  app.post('/api/approvals/:id/edit', { preHandler: mut }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ subject: z.string().max(200).nullable().optional(), body: z.string().min(10).max(5000).optional() }).parse(req.body);
    await editDraft(ctx.pool, id, { id: req.user!.id, ip: req.ip }, body);
    return { ok: true };
  });
}
