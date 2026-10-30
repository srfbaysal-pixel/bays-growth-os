import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../../../db/migrations');

export class DatabaseIdentityError extends Error {}

/**
 * Hedef veritabanı kimliğini doğrular. Kural:
 *  - Adı 'n8n' içeren bir veritabanında ASLA çalışmaz (mevcut otomasyon DB'si koruması).
 *  - Ad, beklenen adla (EXPECTED_DB_NAME) birebir eşleşmeli; eşleşmiyorsa durur.
 * Geçersiz kılma yoktur; doğru hedef için EXPECTED_DB_NAME değiştirilir.
 */
export async function assertDatabaseIdentity(db: { query: pg.Pool['query'] }, expectedName: string): Promise<string> {
  const r = await db.query('SELECT current_database() AS name, current_user AS "user"');
  const name = String(r.rows[0]?.name ?? '');
  if (!name) throw new DatabaseIdentityError('Veritabanı adı okunamadı');
  if (/n8n/i.test(name)) throw new DatabaseIdentityError(`Durduruldu: hedef veritabanı "${name}" n8n'e ait görünüyor. Bu sistem yalnız kendi veritabanında çalışır.`);
  if (name !== expectedName) throw new DatabaseIdentityError(`Durduruldu: hedef veritabanı "${name}", beklenen "${expectedName}" değil (EXPECTED_DB_NAME).`);
  return name;
}

export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR, expectedName?: string): Promise<string[]> {
  if (expectedName !== undefined) await assertDatabaseIdentity(pool, expectedName);
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      done.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${f} başarısız: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return done;
}

/** Yalnızca test veritabanlarında: tüm şemayı sıfırlar. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const dbName = (await pool.query('SELECT current_database() AS n')).rows[0].n as string;
  if (/n8n/i.test(dbName)) throw new DatabaseIdentityError(`resetDatabase n8n veritabanında çalıştırılamaz (${dbName})`);
  if (!/test/i.test(dbName)) throw new DatabaseIdentityError(`resetDatabase yalnızca adında 'test' geçen veritabanlarında çalışır (${dbName})`);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
