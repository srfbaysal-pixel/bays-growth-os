import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerPlugins } from './plugins.js';
import { authRoutes } from './routes/auth.js';
import { leadRoutes } from './routes/leads.js';
import { approvalRoutes } from './routes/approvals.js';
import { salesRoutes } from './routes/sales.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { internalRoutes } from './routes/internal.js';

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: ctx.cfg.NODE_ENV !== 'test', trustProxy: true, bodyLimit: 2_500_000 });
  registerPlugins(app, ctx);
  authRoutes(app, ctx);
  leadRoutes(app, ctx);
  approvalRoutes(app, ctx);
  salesRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  internalRoutes(app, ctx);
  return app;
}
