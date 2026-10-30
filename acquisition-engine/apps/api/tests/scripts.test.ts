/** D5 — backup/restore betikleri: yalnız geçici test DB'sinde; parola sızıntısı, yanlış hedef, bozuk sağlama. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshDb, closeTestPool, testPool, TEST_DB_URL } from './helpers.js';
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

/** D5 takip (Work bulguları): checksum SEÇİLEN dump'ı doğrular; özel karakterli parolalar hiçbir çıktıda kalmaz. */
describe.skipIf(!hasTools)('D5 takip — checksum seçilen dosyayı doğrular, özel karakterli parola sızmaz', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bays-bk2-'));
  // Ham (percent-encoded) ve çözülmüş biçim: p@ss/w0&rd*.$[x]#\  — sed/regex özel karakterleri içerir
  const RAW = 'p%40ss%2Fw0%26rd%2A.%24%5Bx%5D%23%5C';
  const DEC = 'p@ss/w0&rd*.$[x]#\\';
  const specialUrl = (db: string, user = 'bays_acq') => `postgres://${user}:${RAW}@127.0.0.1:5432/${db}`;
  const sh = (script: string) => spawnSync('bash', ['-c', `. deploy/scripts/db-common.sh; ${script}`], { cwd: ROOT, encoding: 'utf8' });
  const noLeak = (out: string) => { expect(out).not.toContain(RAW); expect(out).not.toContain(DEC); expect(out).not.toContain('w0&rd'); expect(out).not.toContain('w0%26rd'); };

  it('redact/mask: ham ve çözülmüş parola düz metin olarak silinir; regex özel karakterleri etkisiz', () => {
    const r = sh(`printf 'a %s b %s c\\n' '${RAW}' '${DEC.replace(/'/g, "'\\''")}' | redact '${specialUrl('bays_acq_test')}'; mask_url '${specialUrl('bays_acq_test')}'; echo; url_db_name '${specialUrl('bays_acq_test')}'`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('a *** b *** c');
    expect(r.stdout).toContain('postgres://bays_acq:***@127.0.0.1:5432/bays_acq_test');
    expect(r.stdout.trim().endsWith('bays_acq_test')).toBe(true);
    noLeak(r.stdout + r.stderr);
    // Parola yoksa çıktı değişmez; '/' ve '&' içeren parola URL ayrıştırmasını bozmaz
    expect(sh(`printf 'x\\n' | redact 'postgres://u@h/db'; mask_url 'postgres://u@h/db'`).stdout).toBe('x\npostgres://u@h/db');
  });
  it('bağlantı hatası ve kimlik reddi çıktılarında parola yok (psql hata metni dahil)', () => {
    const r = run('backup.sh', [dir], { DATABASE_URL: specialUrl('bays_acq_test_yok'), EXPECTED_DB_NAME: 'bays_acq_test_yok' });
    expect(r.code).toBe(2); expect(r.out).toMatch(/hedefe bağlanılamadı \(postgres:\/\/bays_acq:\*\*\*@/); noLeak(r.out);
    const n8n = run('restore.sh', [path.join(dir, 'yok.dump'), '--target', specialUrl('N8N'), '--yes'], {});
    expect(n8n.code).toBe(3); noLeak(n8n.out); // dosya kontrolü önce; yine de sızıntı yok
    expect(readdirSync(dir).filter((f) => f.endsWith('.dump')).length).toBe(0);
  });
  it('gerçek özel karakterli rol ile yedek alınır ve tüm çıktılar temizdir (rol yoksa atlanır)', async () => {
    const exists = (await testPool().query(`SELECT 1 FROM pg_roles WHERE rolname = 'bays_acq_special'`)).rowCount === 1;
    if (!exists) { console.warn('bays_acq_special rolü yok (CREATEROLE gerekir), pozitif özel parola testi atlandı'); return; }
    // Şema sahibi (bays_acq) test rolüne salt okuma verir; freshDb şemayı yeniden kurduğu için her seferinde
    await testPool().query('GRANT USAGE ON SCHEMA public TO bays_acq_special; GRANT SELECT ON ALL TABLES IN SCHEMA public TO bays_acq_special; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO bays_acq_special');
    const r = run('backup.sh', [dir], { DATABASE_URL: specialUrl('bays_acq_test', 'bays_acq_special'), EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(r.code, r.out).toBe(0); expect(r.out).toMatch(/Hedef doğrulandı: postgres:\/\/bays_acq_special:\*\*\*@/); noLeak(r.out);
    expect(readdirSync(dir).some((f) => /^bays_acq_test-.*\.dump$/.test(f))).toBe(true);
  });
  it('checksum: .sha256 içindeki dosya adı değil, seçilen dump\'ın özeti karşılaştırılır', () => {
    const backup = run('backup.sh', [dir], { DATABASE_URL: TEST_DB_URL, EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(backup.code, backup.out).toBe(0);
    const dump = path.join(dir, readdirSync(dir).filter((f) => /^bays_acq_test-.*\.dump$/.test(f)).sort().pop()!);
    const sumLine = readFileSync(dump + '.sha256', 'utf8');
    expect(sumLine).toMatch(new RegExp(`^[0-9a-f]{64}  ${path.basename(dump).replace(/[.]/g, '\\.')}\\n$`)); // taşınabilir biçim
    expect(spawnSync('sha256sum', ['-c', '--quiet', path.basename(dump) + '.sha256'], { cwd: dir }).status).toBe(0);
    const goodHash = sumLine.split(' ')[0];
    // (1) Kurcalanmış kopya + geçerli BAŞKA dosyayı işaret eden .sha256 → reddedilir (eski davranış kabul ediyordu)
    const tampered = path.join(dir, 'tampered.dump');
    writeFileSync(tampered, Buffer.concat([readFileSync(dump), Buffer.from('x')]));
    writeFileSync(tampered + '.sha256', `${goodHash}  ${path.basename(dump)}\n`);
    const t = run('restore.sh', [tampered, '--target', TEST_DB_URL, '--yes'], { EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(t.code).toBe(3); expect(t.out).toMatch(/sağlama uyuşmuyor.*tampered\.dump/);
    // (2) Doğru özet, yanlış/eski dosya adı → seçilen dosya doğrulanır, geri yükleme ilerler
    const copy = path.join(dir, 'renamed-copy.dump');
    writeFileSync(copy, readFileSync(dump));
    writeFileSync(copy + '.sha256', `${goodHash}  eski-ad.dump\n`);
    const ok = run('restore.sh', [copy, '--target', TEST_DB_URL, '--yes'], { EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(ok.code, ok.out).toBe(0);
    // (3) Geçersiz biçimli .sha256 → reddedilir
    writeFileSync(copy + '.sha256', `not-a-hash  renamed-copy.dump\n`);
    expect(run('restore.sh', [copy, '--target', TEST_DB_URL, '--yes'], { EXPECTED_DB_NAME: 'bays_acq_test' }).code).toBe(3);
    // (4) Göreli hedef dizinle alınan yedeğin .sha256'sı mutlak yol içermez
    const rel = 'backups-test-rel';
    const b2 = run('backup.sh', [rel], { DATABASE_URL: TEST_DB_URL, EXPECTED_DB_NAME: 'bays_acq_test' });
    expect(b2.code, b2.out).toBe(0);
    const relDir = path.join(ROOT, rel);
    const relSum = readdirSync(relDir).find((f) => f.endsWith('.sha256'))!;
    expect(readFileSync(path.join(relDir, relSum), 'utf8')).not.toContain('/');
    for (const f of readdirSync(relDir)) rmSync(path.join(relDir, f)); rmSync(relDir, { recursive: true, force: true });
  });
});
