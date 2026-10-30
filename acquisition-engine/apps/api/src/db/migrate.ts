import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../../../db/migrations');

export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
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
  if (!/test/i.test(dbName)) throw new Error(`resetDatabase yalnızca adında 'test' geçen veritabanlarında çalışır (${dbName})`);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
