import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const list = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DRY_RUN: bool.default(true),
  LIVE_OUTREACH_ENABLED: bool.default(false),
  TEST_RECIPIENTS: list,
  CLINIC_HEALTH_DATA_COLLECTION: bool.default(false),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: int(4100),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4200'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET en az 32 karakter olmalı'),
  SESSION_TTL_HOURS: int(72),
  N8N_SHARED_SECRET: z.string().min(16, 'N8N_SHARED_SECRET en az 16 karakter olmalı'),
  N8N_WEBHOOK_BASE_URL: z.string().optional(),
  RATE_LIMIT_PER_MINUTE: int(120),
  LOGIN_RATE_LIMIT_PER_15MIN: int(10),

  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  DISCOVERY_PROVIDER: z.enum(['google_places', 'mock', 'csv']).default('mock'),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  GOOGLE_PLACES_DAILY_LIMIT: int(200),
  WEBSITE_FETCH_ENABLED: bool.default(true),
  WEBSITE_FETCH_TIMEOUT_MS: int(8000),

  AI_PROVIDER: z.enum(['anthropic', 'mock']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  AI_DAILY_CALL_LIMIT: int(500),

  EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'mock']).default('mock'),
  EMAIL_FROM_NAME: z.string().default('BaysSystems'),
  EMAIL_FROM_ADDRESS: z.string().default('noreply@example.invalid'),
  EMAIL_REPLY_DOMAIN: z.string().default('example.invalid'),
  EMAIL_DAILY_QUOTA: int(50),
  EMAIL_HOURLY_QUOTA: int(10),
  EMAIL_MAX_BOUNCE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  EMAIL_MAX_CONSECUTIVE_ERRORS: int(3),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  WHATSAPP_ENABLED: bool.default(false),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  COMPLIANCE_IYS_VERIFIED: bool.default(false),
  COMPLIANCE_KVKK_VERIFIED: bool.default(false),
  COMPLIANCE_CLINIC_ADVERTISING_VERIFIED: bool.default(false)
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

/** Ortam değişkenlerini doğrular. Eksik/yanlış değerde açık hata verir. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, override?: Partial<Config>): Config {
  const parsed = ConfigSchema.safeParse({ ...env, ...(override ?? {}) });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Yapılandırma hatası: ${issues}`);
  }
  const cfg = parsed.data;
  // Güvenlik: üretimde canlı gönderim açıkken DRY_RUN kapalı olmalı, aksi halde kafa karışıklığı
  if (cfg.LIVE_OUTREACH_ENABLED && cfg.DRY_RUN) {
    // DRY_RUN her zaman baskındır; canlı bayrağı etkisiz kalır. Açıkça belgelenir.
    cfg.LIVE_OUTREACH_ENABLED = false;
  }
  return cfg;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function setConfigForTests(cfg: Config): void {
  cached = cfg;
}

/** Testlerde kullanılan güvenli varsayılanlar. */
export function testConfig(over: Partial<Config> = {}): Config {
  return loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? 'postgres://bays_acq:bays_acq_dev@127.0.0.1:5432/bays_acq_test',
      SESSION_SECRET: 'test-session-secret-test-session-secret-0000',
      N8N_SHARED_SECRET: 'test-n8n-shared-secret-0000',
      EMAIL_PROVIDER: 'mock',
      AI_PROVIDER: 'mock',
      DISCOVERY_PROVIDER: 'mock',
      DRY_RUN: 'true',
      LIVE_OUTREACH_ENABLED: 'false',
      TEST_RECIPIENTS: 'test@example.com',
      EMAIL_FROM_ADDRESS: 'iletisim@test.invalid',
      EMAIL_REPLY_DOMAIN: 'test.invalid'
    },
    over
  );
}
