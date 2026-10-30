import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireSameOrigin } from '../plugins.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { suppressBusinessEverywhere } from '../../outreach/policy.js';
import { audit } from '../../audit.js';
import { csvToBusinesses } from '../../discovery/csv.js';
import { recordDiscoveryObservations, upsertBusiness, upsertContact } from '../../discovery/pipeline.js';
import { getSector } from '../../sectors/loader.js';
import { scoreBusiness } from '../../scoring/score.js';

const uuid = z.string().uuid();

export function leadRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/leads', { preHandler: requireUser() }, async (req) => {
    const q = z.object({ sector: z.string().optional(), status: z.string().optional(), search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const rows = await ctx.pool.query(
      `SELECT b.id, b.name, b.sector_key, b.city, b.district, b.status, b.lead_score, b.website, b.phone_e164, b.email_public, b.instagram_handle, b.recommended_service_key, b.rating, b.review_count, b.created_at,
              (SELECT stage FROM deals d WHERE d.business_id = b.id AND d.stage NOT IN ('won','lost') LIMIT 1) AS deal_stage
         FROM businesses b
        WHERE ($1::text IS NULL OR b.sector_key = $1) AND ($2::text IS NULL OR b.status = $2)
          AND ($3::text IS NULL OR b.name ILIKE '%' || $3 || '%' OR b.city ILIKE '%' || $3 || '%')
        ORDER BY b.lead_score DESC, b.created_at DESC LIMIT $4 OFFSET $5`,
      [q.sector ?? null, q.status ?? null, q.search ?? null, q.limit, q.offset]
    );
    const total = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM businesses b WHERE ($1::text IS NULL OR b.sector_key = $1) AND ($2::text IS NULL OR b.status = $2)`, [q.sector ?? null, q.status ?? null]);
    return { items: rows.rows, total: total.rows[0].n };
  });

  app.get('/api/leads/:id', { preHandler: requireUser() }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = (await ctx.pool.query('SELECT * FROM businesses WHERE id = $1', [id])).rows[0];
    if (!b) throw notFound();
    const [contacts, evidence, scores, perms, drafts, deals, tasks, inbound, suppressed] = await Promise.all([
      ctx.pool.query('SELECT * FROM contacts WHERE business_id = $1 ORDER BY is_primary DESC', [id]),
      ctx.pool.query('SELECT id, source_key, kind, field, value, confidence, evidence_url, captured_at FROM research_evidence WHERE business_id = $1 ORDER BY kind, field', [id]),
      ctx.pool.query('SELECT score, breakdown, model_version, scored_at FROM lead_scores WHERE business_id = $1 ORDER BY scored_at DESC LIMIT 5', [id]),
      ctx.pool.query('SELECT channel, status, basis, verified_at FROM channel_permissions WHERE business_id = $1', [id]),
      ctx.pool.query('SELECT id, channel, status, subject, created_at FROM message_drafts WHERE business_id = $1 ORDER BY created_at DESC', [id]),
      ctx.pool.query('SELECT * FROM deals WHERE business_id = $1 ORDER BY created_at DESC', [id]),
      ctx.pool.query('SELECT * FROM tasks WHERE business_id = $1 ORDER BY status, due_at NULLS LAST', [id]),
      ctx.pool.query('SELECT id, from_address, subject, classification, received_at, needs_human_review FROM inbound_messages WHERE matched_business_id = $1 ORDER BY received_at DESC', [id]),
      ctx.pool.query(`SELECT kind, value, reason FROM suppressions WHERE (kind = 'business' AND value = $1::text) OR (kind='domain' AND value = $2) OR (kind='phone' AND value = $3)`, [id, b.domain, b.phone_e164])
    ]);
    return { business: b, contacts: contacts.rows, evidence: evidence.rows, scores: scores.rows, permissions: perms.rows, drafts: drafts.rows, deals: deals.rows, tasks: tasks.rows, inbound: inbound.rows, suppressions: suppressed.rows };
  });

  app.post('/api/leads/:id/suppress', { preHandler: [requireUser('operator'), requireSameOrigin(ctx.cfg)] }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ reason: z.string().min(2).max(300) }).parse(req.body);
    await suppressBusinessEverywhere(ctx.pool, id, body.reason, 'manual', req.user!.id);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'business_suppressed', entityType: 'business', entityId: id, after: body, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/leads/:id/permissions', { preHandler: [requireUser('operator'), requireSameOrigin(ctx.cfg)] }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ channel: z.enum(['email', 'whatsapp', 'instagram', 'linkedin', 'phone']), status: z.enum(['unknown', 'allowed', 'opt_in', 'opt_out', 'blocked']), basis: z.string().max(300).optional(), evidence_url: z.string().url().optional() }).parse(req.body);
    await ctx.pool.query(
      `INSERT INTO channel_permissions(business_id, channel, status, basis, evidence_url, verified_by, verified_at) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (business_id, COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid), channel) DO UPDATE SET status = EXCLUDED.status, basis = EXCLUDED.basis, evidence_url = EXCLUDED.evidence_url, verified_by = EXCLUDED.verified_by, verified_at = now(), updated_at = now()`,
      [id, body.channel, body.status, body.basis ?? null, body.evidence_url ?? null, req.user!.id]
    );
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'permission_set', entityType: 'business', entityId: id, after: body, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/leads/:id/contacts', { preHandler: [requireUser('operator'), requireSameOrigin(ctx.cfg)] }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ email: z.string().email().optional(), phone: z.string().max(30).optional(), full_name: z.string().max(120).optional(), role_title: z.string().max(120).optional() }).parse(req.body);
    const cid = await upsertContact(ctx.pool, id, { ...body, source_key: 'manual' });
    if (!cid) throw badRequest('E-posta veya telefon gerekli');
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'contact_added', entityType: 'business', entityId: id, after: { contact_id: cid }, ip: req.ip });
    return { contact_id: cid };
  });

  app.post('/api/leads/import-csv', { preHandler: [requireUser('operator'), requireSameOrigin(ctx.cfg)] }, async (req) => {
    const body = z.object({ sector_key: z.string(), csv: z.string().max(2_000_000) }).parse(req.body);
    const sector = await getSector(ctx.pool, body.sector_key);
    if (!sector) throw badRequest('Sektör yok');
    const items = csvToBusinesses(body.csv);
    let created = 0, merged = 0;
    for (const b of items) {
      const up = await upsertBusiness(ctx.pool, sector.key, b);
      up.created ? created++ : merged++;
      await recordDiscoveryObservations(ctx.pool, up.id, b);
      if (b.email) await upsertContact(ctx.pool, up.id, { email: b.email, source_key: 'csv_import', is_primary: true });
      await scoreBusiness(ctx.pool, sector, up.id);
    }
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'csv_import', after: { created, merged }, ip: req.ip });
    return { created, merged, total: items.length };
  });

  app.get('/api/sectors', { preHandler: requireUser() }, async () => (await ctx.pool.query('SELECT key, name, config FROM sectors WHERE is_active ORDER BY key')).rows);
  app.get('/api/services', { preHandler: requireUser() }, async () => ({
    services: (await ctx.pool.query('SELECT key, name, description, sector_fit FROM services WHERE is_active ORDER BY key')).rows,
    plans: (await ctx.pool.query('SELECT id, service_key, name, setup_fee_cents, monthly_fee_cents, currency, is_active, notes FROM price_plans ORDER BY service_key, name')).rows
  }));
  app.put('/api/services/plans/:id', { preHandler: [requireUser('owner'), requireSameOrigin(ctx.cfg)] }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z.object({ setup_fee_cents: z.number().int().min(0).optional(), monthly_fee_cents: z.number().int().min(0).optional(), is_active: z.boolean().optional(), notes: z.string().max(300).nullable().optional() }).parse(req.body);
    const before = (await ctx.pool.query('SELECT * FROM price_plans WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    await ctx.pool.query('UPDATE price_plans SET setup_fee_cents = COALESCE($2, setup_fee_cents), monthly_fee_cents = COALESCE($3, monthly_fee_cents), is_active = COALESCE($4, is_active), notes = COALESCE($5, notes) WHERE id = $1', [id, body.setup_fee_cents ?? null, body.monthly_fee_cents ?? null, body.is_active ?? null, body.notes ?? null]);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: 'price_plan_updated', entityType: 'price_plan', entityId: id, before, after: body, ip: req.ip });
    return { ok: true };
  });
}
