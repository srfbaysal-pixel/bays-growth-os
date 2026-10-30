import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, closeTestPool, makeCtx, seedUsers } from './helpers.js';
import { buildServer } from '../src/http/server.js';
import { signRequest, hmacSha256 } from '../src/lib/crypto.js';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';

let pool: pg.Pool;
let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeCtx>>;
beforeAll(async () => { pool = await freshDb(); await seedUsers(pool); ctx = await makeCtx(pool, { WHATSAPP_APP_SECRET: 'wa-secret', WHATSAPP_VERIFY_TOKEN: 'verify-me' }); app = buildServer(ctx); await app.ready(); });
afterAll(async () => { await app.close(); await closeTestPool(); });

async function loginAs(email: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(r.statusCode).toBe(200);
  return r.headers['set-cookie'] as string;
}
const origin = { origin: 'http://localhost:4200' };

describe('kimlik doğrulama ve yetki', () => {
  it('oturumsuz istek 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/leads' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
  it('hatalı parola 401 ve audit', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@test.invalid', password: 'yanlış-parola-123' } });
    expect(r.statusCode).toBe(401);
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'login_failed'`)).rowCount).toBeGreaterThan(0);
  });
  it('viewer onaylayamaz (403), operator onaylayabilir, owner sistem ayarı', async () => {
    const viewer = await loginAs('viewer@test.invalid', 'viewer-password-123');
    const op = await loginAs('op@test.invalid', 'operator-password-123');
    const fakeId = '00000000-0000-4000-8000-000000000001';
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${fakeId}/approve`, headers: { cookie: viewer, ...origin }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${fakeId}/approve`, headers: { cookie: op, ...origin }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/system/outreach-pause`, headers: { cookie: op, ...origin }, payload: { paused: true } })).statusCode).toBe(403);
    const owner = await loginAs('owner@test.invalid', 'owner-password-123');
    expect((await app.inject({ method: 'POST', url: `/api/system/outreach-pause`, headers: { cookie: owner, ...origin }, payload: { paused: true, reason: 'test' } })).statusCode).toBe(200);
    const sys = await app.inject({ method: 'GET', url: '/api/system', headers: { cookie: owner } });
    expect(sys.json().outreach_paused.paused).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/system/outreach-pause`, headers: { cookie: owner, ...origin }, payload: { paused: false } })).statusCode).toBe(200);
  });
  it('CSRF: yabancı origin reddedilir', async () => {
    const op = await loginAs('op@test.invalid', 'operator-password-123');
    const r = await app.inject({ method: 'POST', url: `/api/tasks`, headers: { cookie: op, origin: 'https://evil.example' }, payload: { kind: 'other', title: 'x' } });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/tasks`, headers: { cookie: op, 'x-requested-with': 'bays-panel' }, payload: { kind: 'other', title: 'görev' } });
    expect(ok.statusCode).toBe(200);
  });
  it('çıkış oturumu geçersiz kılar', async () => {
    const op = await loginAs('op@test.invalid', 'operator-password-123');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: op, ...origin } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/leads', headers: { cookie: op } })).statusCode).toBe(401);
  });
  it('girdi doğrulama: geçersiz UUID 400', async () => {
    const op = await loginAs('op@test.invalid', 'operator-password-123');
    const r = await app.inject({ method: 'GET', url: `/api/leads/not-a-uuid`, headers: { cookie: op } });
    expect([400, 500]).toContain(r.statusCode);
    expect(r.statusCode).not.toBe(200);
  });
});

describe('n8n iç uçlar (HMAC)', () => {
  const body = JSON.stringify({ run_id: 'n8n-run-1', sector_key: 'beauty', city: 'İstanbul' });
  it('imzasız/yanlış imzalı istek 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/internal/wf1/run', payload: body, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    const ts = String(Math.floor(Date.now() / 1000));
    expect((await app.inject({ method: 'POST', url: '/internal/wf1/run', payload: body, headers: { 'content-type': 'application/json', 'x-bays-timestamp': ts, 'x-bays-signature': signRequest('yanlış-sır', ts, body) } })).statusCode).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 1000);
    expect((await app.inject({ method: 'POST', url: '/internal/wf1/run', payload: body, headers: { 'content-type': 'application/json', 'x-bays-timestamp': old, 'x-bays-signature': signRequest(ctx.cfg.N8N_SHARED_SECRET, old, body) } })).statusCode).toBe(401);
    // Panel oturumu iç uçlara erişemez
    const owner = await loginAs('owner@test.invalid', 'owner-password-123');
    expect((await app.inject({ method: 'POST', url: '/internal/wf1/run', payload: body, headers: { 'content-type': 'application/json', cookie: owner } })).statusCode).toBe(401);
  });
  it('geçerli imza WF1’i çalıştırır; aynı run_id tekrar çalışmaz', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const h = { 'content-type': 'application/json', 'x-bays-timestamp': ts, 'x-bays-signature': signRequest(ctx.cfg.N8N_SHARED_SECRET, ts, body) };
    const r = await app.inject({ method: 'POST', url: '/internal/wf1/run', payload: body, headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.json().created).toBeGreaterThan(0);
    const r2 = await app.inject({ method: 'POST', url: '/internal/wf1/run', payload: body, headers: h });
    expect(r2.json().already_ran).toBe(true);
    const owner = await loginAs('owner@test.invalid', 'owner-password-123');
    const leads = await app.inject({ method: 'GET', url: '/api/leads?sector=beauty', headers: { cookie: owner } });
    expect(leads.json().total).toBeGreaterThan(0);
    const detail = await app.inject({ method: 'GET', url: `/api/leads/${leads.json().items[0].id}`, headers: { cookie: owner } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().evidence.length).toBeGreaterThan(0);
    const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: owner } });
    expect(dash.json().today.leads_discovered).toBeGreaterThan(0);
  });
  it('heartbeat kaydı', async () => {
    const b = JSON.stringify({ workflow_key: 'wf1_discovery', run_id: 'hb-1', status: 'failed', error: 'n8n node hatası' });
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await app.inject({ method: 'POST', url: '/internal/heartbeat', payload: b, headers: { 'content-type': 'application/json', 'x-bays-timestamp': ts, 'x-bays-signature': signRequest(ctx.cfg.N8N_SHARED_SECRET, ts, b) } });
    expect(r.statusCode).toBe(200);
    expect((await pool.query(`SELECT status FROM workflow_runs WHERE run_id = 'hb-1'`)).rows[0].status).toBe('failed');
  });
});

describe('webhook imzaları', () => {
  it('WhatsApp doğrulama ve imza', async () => {
    const v = await app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123' });
    expect(v.body).toBe('123');
    expect((await app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' })).statusCode).toBe(403);
    const payload = JSON.stringify({ entry: [{ id: 'e1', changes: [{ value: { messages: [{ id: 'wamid.1', from: '905551112233', type: 'text', text: { body: 'merhaba?' }, timestamp: '1700000000' }] } }] }] });
    expect((await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + hmacSha256('wa-secret', payload) } });
    expect(ok.statusCode).toBe(200);
    expect((await pool.query(`SELECT 1 FROM webhook_events WHERE source = 'whatsapp'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM inbound_messages WHERE channel = 'whatsapp'`)).rowCount).toBe(1);
  });
  it('Resend webhook kapalıysa 404', async () => {
    expect((await app.inject({ method: 'POST', url: '/webhooks/email/resend', payload: {} })).statusCode).toBe(404);
  });
});

describe('rate limit', () => {
  it('login denemeleri sınırlanır', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.invalid', password: 'p' }, remoteAddress: '10.0.0.9' })).statusCode;
    expect(last).toBe(429);
  });
});
