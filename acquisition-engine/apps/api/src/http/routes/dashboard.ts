import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireSameOrigin } from '../plugins.js';
import { computeDayMetrics, weeklySummary } from '../../metrics/daily.js';
import { systemHealth } from '../../health/status.js';
import { setOutreachPaused } from '../../outreach/policy.js';
import { audit } from '../../audit.js';
import { runEmailPreflight } from '../../email/preflight.js';

export function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/dashboard', { preHandler: requireUser() }, async (req) => {
    const q = z.object({ day: z.string().date().optional(), sector: z.string().optional() }).parse(req.query);
    const day = q.day ?? new Date().toISOString().slice(0, 10);
    const today = await computeDayMetrics(ctx.pool, day, q.sector ?? null);
    const yesterday = await computeDayMetrics(ctx.pool, new Date(new Date(day).getTime() - 86400e3).toISOString().slice(0, 10), q.sector ?? null);
    const week = await weeklySummary(ctx.pool, day);
    const funnel = (await ctx.pool.query(`SELECT status, COUNT(*)::int AS n FROM businesses WHERE ($1::text IS NULL OR sector_key = $1) GROUP BY status`, [q.sector ?? null])).rows;
    const bySector = (await ctx.pool.query(`SELECT s.key, s.name, COUNT(b.id)::int AS leads, COUNT(b.id) FILTER (WHERE b.status = 'qualified')::int AS qualified, COUNT(b.id) FILTER (WHERE b.status IN ('contacted','replied'))::int AS contacted, COUNT(b.id) FILTER (WHERE b.status = 'customer')::int AS customers FROM sectors s LEFT JOIN businesses b ON b.sector_key = s.key WHERE s.is_active GROUP BY s.key, s.name ORDER BY s.key`)).rows;
    return { day, today, yesterday, week, funnel: Object.fromEntries(funnel.map((f) => [f.status, f.n])), by_sector: bySector, mode: { dry_run: ctx.cfg.DRY_RUN, live_outreach_enabled: ctx.cfg.LIVE_OUTREACH_ENABLED } };
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
  app.get('/api/system', { preHandler: requireUser() }, async () => systemHealth(ctx.pool, ctx.cfg));
  app.post('/api/system/outreach-pause', { preHandler: [requireUser('owner'), requireSameOrigin(ctx.cfg)] }, async (req) => {
    const body = z.object({ paused: z.boolean(), reason: z.string().max(300).nullable().optional() }).parse(req.body);
    await setOutreachPaused(ctx.pool, body.paused, body.reason ?? null, req.user!.id);
    await audit(ctx.pool, { actorType: 'user', actorId: req.user!.id, action: body.paused ? 'outreach_paused' : 'outreach_resumed', after: body, ip: req.ip });
    return { ok: true };
  });
  app.get('/api/system/email-preflight', { preHandler: requireUser('owner') }, async () => ({ checks: await runEmailPreflight(ctx.cfg), provider: await ctx.email.verify().catch((e) => ({ ok: false, detail: (e as Error).message })) }));
  app.get('/api/audit', { preHandler: requireUser('owner') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return { items: (await ctx.pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [q.limit])).rows };
  });
}
