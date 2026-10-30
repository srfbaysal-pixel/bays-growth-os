/** D1 — opsiyonel boş değerler ve .env.example yüklenebilirliği */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, testConfig } from '../src/config.js';
import { notifyAdmin } from '../src/health/notify.js';

const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/bays_acq', SESSION_SECRET: 'x'.repeat(40), N8N_SHARED_SECRET: 'y'.repeat(20) };

describe('D1 — opsiyonel URL ve boş ortam değişkenleri', () => {
  it('eksik, boş ve yalnız boşluk → bildirim kapalı (undefined)', () => {
    expect(loadConfig({ ...base } as any).ALERT_WEBHOOK_URL).toBeUndefined();
    expect(loadConfig({ ...base, ALERT_WEBHOOK_URL: '' } as any).ALERT_WEBHOOK_URL).toBeUndefined();
    expect(loadConfig({ ...base, ALERT_WEBHOOK_URL: '   ' } as any).ALERT_WEBHOOK_URL).toBeUndefined();
    expect(loadConfig({ ...base, ALERT_WEBHOOK_URL: ' https://n8n.example/webhook/x ' } as any).ALERT_WEBHOOK_URL).toBe('https://n8n.example/webhook/x');
  });
  it('dolu geçersiz URL açık hata verir ve değeri/sırrı içermez', () => {
    const bad = 'not a url with secret token-ABC123';
    let err = '';
    try { loadConfig({ ...base, ALERT_WEBHOOK_URL: bad } as any); } catch (e) { err = (e as Error).message; }
    expect(err).toMatch(/ALERT_WEBHOOK_URL/);
    expect(err).not.toContain('ABC123');
    expect(err).not.toContain('p@127');
  });
  it('diğer opsiyonel alanlarda boş değer varsayılana düşer, doğrulama gevşemez', () => {
    const c = loadConfig({ ...base, GOOGLE_PLACES_API_KEY: '', N8N_WEBHOOK_BASE_URL: ' ', DRY_RUN: '', EMAIL_PROVIDER: '', RATE_LIMIT_PER_MINUTE: '' } as any);
    expect(c.GOOGLE_PLACES_API_KEY).toBeUndefined(); expect(c.N8N_WEBHOOK_BASE_URL).toBeUndefined();
    expect(c.DRY_RUN).toBe(true); expect(c.EMAIL_PROVIDER).toBe('mock'); expect(c.RATE_LIMIT_PER_MINUTE).toBe(120);
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'sendgrid' } as any)).toThrow(/EMAIL_PROVIDER/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'kısa' } as any)).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, DATABASE_URL: '' } as any)).toThrow(/DATABASE_URL/);
  });
  it('.env.example yalnız zorunlu yer tutucular değiştirilince yüklenir ve güvenli varsayılanlar korunur', () => {
    const text = readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); if (m) env[m[1]] = m[2]; }
    expect(env.ALERT_WEBHOOK_URL).toBe(''); expect(env.N8N_WEBHOOK_BASE_URL).toBe(''); expect(env.AUTO_MIGRATE).toBe('false');
    // Zorunlu yer tutucular: sırlar ve DB parolası
    env.SESSION_SECRET = 's'.repeat(64); env.N8N_SHARED_SECRET = 'n'.repeat(64);
    env.DATABASE_URL = env.DATABASE_URL.replace('CHANGE_ME', 'testpw'); env.ADMIN_PASSWORD = 'uzun-bir-parola-123';
    const c = loadConfig(env);
    expect(c.DRY_RUN).toBe(true); expect(c.LIVE_OUTREACH_ENABLED).toBe(false); expect(c.WHATSAPP_ENABLED).toBe(false);
    expect(c.COMPLIANCE_IYS_VERIFIED).toBe(false); expect(c.COMPLIANCE_KVKK_VERIFIED).toBe(false); expect(c.COMPLIANCE_CLINIC_ADVERTISING_VERIFIED).toBe(false);
    expect(c.EMAIL_PROVIDER).toBe('mock'); expect(c.AI_PROVIDER).toBe('mock'); expect(c.DISCOVERY_PROVIDER).toBe('mock');
    expect(c.ALERT_WEBHOOK_URL).toBeUndefined(); expect(c.EXPECTED_DB_NAME).toBe('bays_acq');
  });
  it('kapalı webhook hiçbir dış çağrı üretmez', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch;
    const cfg = testConfig({ ALERT_WEBHOOK_URL: '   ' as any });
    const db = { query: async () => ({ rows: [{ id: 'x' }], rowCount: 1 }) } as any;
    const r = await notifyAdmin(db, cfg, { kind: 'other', title: 't', body: 'b' }, fetchFn);
    expect(r.webhook).toBe('skipped'); expect(calls).toBe(0);
  });
});
