import type { Queryable } from '../db/pool.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../audit.js';

export type Role = 'owner' | 'operator' | 'viewer';
export interface User { id: string; email: string; display_name: string; role: Role; is_active: boolean }

const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, owner: 3 };
export function hasRole(user: { role: Role }, min: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}

export async function createUser(db: Queryable, input: { email: string; password: string; role: Role; displayName?: string }): Promise<User> {
  if (input.password.length < 12) throw new Error('Parola en az 12 karakter olmalı');
  const hash = await hashPassword(input.password);
  const r = await db.query(
    `INSERT INTO users(email, password_hash, role, display_name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
     RETURNING id, email, display_name, role, is_active`,
    [input.email.toLowerCase(), hash, input.role, input.displayName ?? input.email.split('@')[0]]
  );
  return r.rows[0];
}

export async function login(db: Queryable, email: string, password: string, meta: { ip?: string; ua?: string; ttlHours: number }): Promise<{ token: string; user: User } | null> {
  const r = await db.query('SELECT id, email, display_name, role, is_active, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const row = r.rows[0];
  // Zamanlama sızıntısını azaltmak için kullanıcı yoksa da doğrulama maliyeti harcanır
  const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, 'scrypt$16384$00$00').catch(() => false);
  if (!row || !ok || !row.is_active) {
    await audit(db, { actorType: 'user', actorId: email, action: 'login_failed', ip: meta.ip });
    return null;
  }
  const token = randomToken(32);
  await db.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent) VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4, $5)`,
    [sha256(token), row.id, String(meta.ttlHours), meta.ip ?? null, (meta.ua ?? '').slice(0, 300)]
  );
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
  await audit(db, { actorType: 'user', actorId: row.id, action: 'login', ip: meta.ip });
  const { password_hash: _ph, ...user } = row;
  return { token, user };
}

export async function resolveSession(db: Queryable, token: string): Promise<User | null> {
  const r = await db.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [sha256(token)]
  );
  return r.rows[0] ?? null;
}

export async function logout(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function purgeExpiredSessions(db: Queryable): Promise<number> {
  const r = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  return r.rowCount ?? 0;
}
