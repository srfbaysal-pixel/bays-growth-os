import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { login, logout } from '../../auth/service.js';
import { sessionCookie, requireUser } from '../plugins.js';
import { badRequest, unauthorized } from '../../lib/errors.js';

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) throw badRequest('E-posta ve parola gerekli');
    const res = await login(ctx.pool, body.data.email, body.data.password, { ip: req.ip, ua: req.headers['user-agent'], ttlHours: ctx.cfg.SESSION_TTL_HOURS });
    if (!res) throw unauthorized('E-posta veya parola hatalı');
    reply.header('Set-Cookie', sessionCookie(res.token, ctx.cfg));
    return { user: res.user };
  });
  app.post('/api/auth/logout', { preHandler: requireUser() }, async (req, reply) => {
    if (req.sessionToken) await logout(ctx.pool, req.sessionToken);
    reply.header('Set-Cookie', sessionCookie('', ctx.cfg, true));
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => ({ user: req.user ?? null, mode: { dry_run: ctx.cfg.DRY_RUN, live_outreach_enabled: ctx.cfg.LIVE_OUTREACH_ENABLED } }));
}
