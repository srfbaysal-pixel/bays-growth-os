/** D5 — backup/restore betikleri: yalnız geçici test DB'sinde; parola sızıntısı, yanlış hedef, bozuk sağlama. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshDb, closeTestPool, TEST_DB_URL } from './helpers.js';
import type pg from 'pg';

const ROOT = path.resolve(__dirname, '../../..');
const PW = 'Sup3rSecretPw';
const pwUrl = (name: string) => `postgres://bays_acq:${PW}@127.0.0.1:5432/${name}`;
const run = (script: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('bash', [path.join(ROOT, 'deploy/scripts', script), ...args], { cwd: ROOT, env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '/tmp', ...env }, encoding: 'utf8', input: '' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
let pool: pg.Pool;
const hasTools = spawnSync('which', ['pg_dump']).status === 0 && spawnSync('which', ['pg_restore']).status === 0;
beforeAll(async () => { pool = await freshDb(); });
afterAll(closeTestPool);

describe.skipIf(!hasTools)('D5 — backup/restore', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bays-bk-'));
  const realUrl = TEST_DB_URL; // gerçek test parolası; çıktıda görünmemeli
  const realPw = /:\/\/[^:]+:([^@]+)@/.exec(realUrl)![1];

  it('yedek: kimlik doğrulanır, dosya + sağlama + okunabilirlik; çıktıda parola yok', () => {
    const r = run('backup.sh', [dir], { DATABASE_URL: realUrl, EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Hedef doğrulandı: postgres:\/\/bays_acq:\*\*\*@/);
    expect(r.out).not.toContain(realPw);
    const files = readdirSync(dir);
    expect(files.some((f) => /^bays_acq_test-.*\.dump$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.dump.sha256'))).toBe(true);
  });
  it('yedek: yanlış beklenen ad ve n8n hedefi işlem başlamadan durur, parola sızmaz', () => {
    const wrong = run('backup.sh', [dir], { DATABASE_URL: realUrl, EXPECTED_DB_NAME: 'bays_acq' });
    expect(wrong.code).toBe(2); expect(wrong.out).toMatch(/beklenen 'bays_acq' değil/); expect(wrong.out).not.toContain(realPw);
    const n8n = run('backup.sh', [dir], { DATABASE_URL: pwUrl('N8N_Prod'), EXPECTED_DB_NAME: 'N8N_Prod' });
    expect(n8n.code).toBe(2); expect(n8n.out).toMatch(/n8n/i); expect(n8n.out).not.toContain(PW); expect(n8n.out).toContain('***');
    expect(readdirSync(dir).filter((f) => f.endsWith('.dump')).length).toBe(1);
  });
  it('geri yükleme: bozuk/eksik sağlama ve yanlış hedefte pg_restore başlamaz; parola sızmaz', async () => {
    const dump = path.join(dir, readdirSync(dir).find((f) => f.endsWith('.dump'))!);
    await pool.query(`INSERT INTO system_flags(key, value, updated_by) VALUES ('restore_marker', '"before"', 'test') ON CONFLICT (key) DO UPDATE SET value = '"before"'`);
    const wrongTarget = run('restore.sh', [dump, '--target', pwUrl('bays_acq_test'), '--yes'], { EXPECTED_DB_NAME: 'bays_acq' });
    expect(wrongTarget.code).toBe(2); expect(wrongTarget.out).not.toContain(PW);
    const n8nTarget = run('restore.sh', [dump, '--target', pwUrl('n8n'), '--yes'], { EXPECTED_DB_NAME: 'n8n' });
    expect(n8nTarget.code).toBe(2); expect(n8nTarget.out).toMatch(/n8n/); expect(n8nTarget.out).not.toContain(PW);
    const noSum = path.join(dir, 'nosum.dump'); writeFileSync(noSum, 'garbage');
    expect(run('restore.sh', [noSum, '--target', realUrl, '--yes'], { EXPECTED_DB_NAME: 'bays_acq_test' }).code).toBe(3);
    writeFileSync(noSum + '.sha256', `0000000000000000000000000000000000000000000000000000000000000000  nosum.dump\n`);
    const bad = run('restore.sh', [noSum, '--target', realUrl, '--yes'], { EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(bad.code).toBe(3); expect(bad.out).toMatch(/sağlama uyuşmuyor/);
    // Hiçbir yanlış senaryo veriyi değiştirmedi
    expect((await pool.query(`SELECT value FROM system_flags WHERE key = 'restore_marker'`)).rows[0].value).toBe('before');
    // Onaysız (--yes yok, stdin boş) → iptal, değişiklik yok
    const noConfirm = run('restore.sh', [dump, '--target', realUrl], { EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(noConfirm.code).toBe(1); expect(noConfirm.out).not.toContain(realPw); expect(noConfirm.out).toContain('***');
    expect((await pool.query(`SELECT value FROM system_flags WHERE key = 'restore_marker'`)).rows[0].value).toBe('before');
  });
  it('geri yükleme: geçerli yedek + doğru hedef + açık onay → veri yedekteki duruma döner', async () => {
    const dump = path.join(dir, readdirSync(dir).find((f) => /^bays_acq_test-.*\.dump$/.test(f))!);
    await closeTestPool();
    const ok = run('restore.sh', [dump, '--target', TEST_DB_URL, '--yes'], { EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(ok.code, ok.out).toBe(0); expect(ok.out).not.toContain(realPw); expect(ok.out).toMatch(/Geri yükleme tamamlandı: postgres:\/\/bays_acq:\*\*\*@/);
    const { default: pg } = await import('pg');
    const p2 = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
    expect((await p2.query(`SELECT 1 FROM system_flags WHERE key = 'restore_marker'`)).rowCount).toBe(0); // yedekte yoktu
    expect((await p2.query(`SELECT 1 FROM sectors WHERE key = 'beauty'`)).rowCount).toBe(1);
    await p2.end();
    expect(existsSync(dump + '.sha256')).toBe(true);
  });
});
