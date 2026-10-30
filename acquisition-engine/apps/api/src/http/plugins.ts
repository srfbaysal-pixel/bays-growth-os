import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { resolveSession, hasRole, type Role } from '../auth/service.js';
import { verifySignature } from '../lib/crypto.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { ipInAnyCidr } from '../lib/ip.js';

export const COOKIE_NAME = 'bays_acq_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, cfg: { PUBLIC_BASE_URL: string; SESSION_TTL_HOURS: number }, clear = false): string {
  const secure = cfg.PUBLIC_BASE_URL.startsWith('https://');
  const maxAge = clear ? 0 : cfg.SESSION_TTL_HOURS * 3600;
  return `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function registerPlugins(app: FastifyInstance, ctx: AppContext) {
  const apiLimiter = new RateLimiter(ctx.cfg.RATE_LIMIT_PER_MINUTE, 60_000);
  const loginLimiter = new RateLimiter(ctx.cfg.LOGIN_RATE_LIMIT_PER_15MIN, 15 * 60_000);

  // Ham gövde (imza doğrulaması için)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBodyText = body as string;
    if (!body || (body as string).length === 0) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { done(new AppError(400, 'Geçersiz JSON', 'bad_json'), undefined); }
  });

  app.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    const limiter = req.url.startsWith('/api/auth/login') ? loginLimiter : apiLimiter;
    const r = limiter.hit(ip);
    reply.header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) { reply.header('Retry-After', String(r.retryAfterSec)); throw new AppError(429, 'Çok fazla istek', 'rate_limited'); }
    // Güvenlik başlıkları
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  // Oturum çözümleme (varsa)
  app.addHook('preHandler', async (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) {
      const user = await resolveSession(ctx.pool, token);
      if (user) { req.user = user; req.sessionToken = token; }
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details ?? null });
    if ((err as any).validation || (err as any).code === 'FST_ERR_VALIDATION') return reply.status(400).send({ error: 'validation', message: err.message });
    const status = (err as any).statusCode && (err as any).statusCode >= 400 ? (err as any).statusCode : 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'internal' : 'error', message: status >= 500 ? 'Sunucu hatası' : err.message });
  });
}

/** Panel kullanıcısı gerektirir; min rol kontrolü sunucu tarafındadır. */
export function requireUser(min: Role = 'viewer') {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw unauthorized();
    if (!hasRole(req.user, min)) throw forbidden();
  };
}

/**
 * n8n ↔ API (Ö1): iki katman.
 *  1) Ağ: kaynak IP INTERNAL_ALLOWED_IPS içinde olmalı (varsayılan loopback + özel ağlar). Caddy arkasında
 *     req.ip X-Forwarded-For'dan gelir (trustProxy yalnız loopback/özel ağ proxy'lerine güvenir).
 *  2) Kimlik: X-Bays-Timestamp + X-Bays-Signature (HMAC-SHA256, 5 dk pencere) zorunlu.
 * Boş liste = ağ katmanı kapalı (yalnız HMAC); üretimde önerilmez.
 */
export function requireN8n(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const allowed = ctx.cfg.INTERNAL_ALLOWED_IPS;
    if (allowed.length > 0 && !ipInAnyCidr(req.ip, allowed)) throw forbidden('Bu uç yalnız izinli ağlardan çağrılabilir (INTERNAL_ALLOWED_IPS)');
    const ts = String(req.headers['x-bays-timestamp'] ?? '');
    const sig = String(req.headers['x-bays-signature'] ?? '');
    const body = req.rawBodyText ?? '';
    if (!ts || !sig || !verifySignature(ctx.cfg.N8N_SHARED_SECRET, ts, body, sig)) throw unauthorized('Geçersiz n8n imzası');
  };
}

/** CSRF koruması: oturumlu mutasyonlarda Origin/Referer PUBLIC_BASE_URL ile eşleşmeli (veya özel başlık). */
export function requireSameOrigin(cfg: { PUBLIC_BASE_URL: string; NODE_ENV: string }) {
  return async (req: FastifyRequest) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers['x-requested-with'] === 'bays-panel') return;
    const origin = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined);
    if (!origin) throw forbidden('Origin eksik');
    try {
      const o = new URL(origin).origin;
      const allowed = [new URL(cfg.PUBLIC_BASE_URL).origin, 'http://localhost:4200', 'http://127.0.0.1:4200'];
      if (!allowed.includes(o)) throw forbidden('Origin uyuşmuyor');
    } catch (e) { if (e instanceof AppError) throw e; throw forbidden('Origin geçersiz'); }
  };
}
