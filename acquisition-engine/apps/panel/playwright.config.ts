import { defineConfig, devices } from '@playwright/test';

const TEST_DB = process.env.DATABASE_URL_TEST ?? 'postgres://bays_acq:bays_acq_dev@127.0.0.1:5432/bays_acq_test';
const apiEnv = {
  NODE_ENV: 'test', DATABASE_URL: TEST_DB, API_PORT: '4100', API_HOST: '127.0.0.1', PUBLIC_BASE_URL: 'http://127.0.0.1:4200',
  SESSION_SECRET: 'e2e-session-secret-e2e-session-secret-0000', N8N_SHARED_SECRET: 'e2e-n8n-shared-secret-0000',
  EMAIL_PROVIDER: 'mock', AI_PROVIDER: 'mock', DISCOVERY_PROVIDER: 'mock', DRY_RUN: 'true', LIVE_OUTREACH_ENABLED: 'false', TEST_RECIPIENTS: 'test@example.com',
  EMAIL_FROM_ADDRESS: 'iletisim@test.invalid', EMAIL_REPLY_DOMAIN: 'test.invalid', LOG_LEVEL: 'error'
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['json', { outputFile: '../../reports/playwright-panel.json' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  // PW_CHROMIUM_PATH: sistemde kurulu Chromium kullanmak için (ör. CI imajı); boşsa Playwright'ın kendi tarayıcısı
  use: { baseURL: 'http://127.0.0.1:4200', trace: 'retain-on-failure', locale: 'tr-TR', ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}) },
  projects: [
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: [
    { command: 'npx tsx src/index.ts', cwd: '../api', url: 'http://127.0.0.1:4100/api/health', reuseExistingServer: false, timeout: 60_000, env: apiEnv },
    { command: 'npx next start -p 4200', url: 'http://127.0.0.1:4200/login', reuseExistingServer: false, timeout: 120_000, env: { API_INTERNAL_URL: 'http://127.0.0.1:4100', NODE_ENV: 'production' } }
  ]
});
