import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { testConfig, setConfigForTests, type Config } from '../src/config.js';
import { runMigrations, resetDatabase } from '../src/db/migrate.js';
import { loadSectorFiles, upsertSectors } from '../src/sectors/loader.js';
import { loadServiceCatalog, upsertServices } from '../src/catalog/services.js';
import { createUser } from '../src/auth/service.js';
import { MockAiProvider } from '../src/ai/mock.js';
import { MockEmailProvider } from '../src/email/mock.js';
import { MockDiscoveryProvider, FIXTURES_DIR } from '../src/discovery/mock.js';
import type { AppContext } from '../src/http/context.js';
import type { Transport, TransportRequest } from '../src/discovery/safeFetch.js';

export const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? 'postgres://bays_acq:bays_acq_dev@127.0.0.1:5432/bays_acq_test';

let pool: pg.Pool | null = null;
export function testPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 4 });
  return pool;
}

export async function freshDb(): Promise<pg.Pool> {
  const p = testPool();
  await resetDatabase(p);
  await runMigrations(p);
  await upsertSectors(p, await loadSectorFiles());
  await upsertServices(p, await loadServiceCatalog());
  return p;
}

export async function closeTestPool() { if (pool) { await pool.end(); pool = null; } }

export function cfg(over: Partial<Config> = {}): Config {
  const c = testConfig(over);
  setConfigForTests(c);
  return c;
}

/** Fixture web siteleri için taşıma katmanı: ağa çıkmaz, doğrulanan adresi kaydeder. */
export async function mockWebsiteTransport(): Promise<Transport & { calls: TransportRequest[] }> {
  const sites = JSON.parse(await readFile(path.join(FIXTURES_DIR, 'mock-websites.json'), 'utf8')) as Record<string, { status: number; html: string }>;
  const calls: TransportRequest[] = [];
  const t = (async (req: TransportRequest) => {
    calls.push(req);
    const url = req.url;
    if (url.endsWith('/robots.txt')) return { status: 404, location: null, body: '', truncated: false };
    const hit = sites[url] ?? sites[url.replace(/\/$/, '')];
    if (!hit) return { status: 404, location: null, body: 'not found', truncated: false };
    return { status: hit.status, location: null, body: hit.html, truncated: false };
  }) as Transport & { calls: TransportRequest[] };
  t.calls = calls;
  return t;
}

/** Testlerde DNS: fixture alan adları herkese açık bir adrese çözülür (SSRF kontrolünden geçer). */
export const publicLookup = async (_host: string) => ['93.184.216.34'];

export async function makeCtx(pool: pg.Pool, over: Partial<Config> = {}): Promise<AppContext & { email: MockEmailProvider; lookup: (h: string) => Promise<string[]>; transport: Transport }> {
  const c = cfg(over);
  return { cfg: c, pool, ai: new MockAiProvider(), email: new MockEmailProvider(), discovery: new MockDiscoveryProvider(), lookup: publicLookup, transport: await mockWebsiteTransport() };
}

export async function seedUsers(pool: pg.Pool) {
  const owner = await createUser(pool, { email: 'owner@test.invalid', password: 'owner-password-123', role: 'owner' });
  const operator = await createUser(pool, { email: 'op@test.invalid', password: 'operator-password-123', role: 'operator' });
  const viewer = await createUser(pool, { email: 'viewer@test.invalid', password: 'viewer-password-123', role: 'viewer' });
  return { owner, operator, viewer };
}
