import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';

const scrypt = (password: string, salt: string, keylen: number, opts: { N: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** scrypt tabanlı parola özeti: scrypt$N$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const N = 16384;
  const key = await scrypt(password, salt, 64, { N });
  return `scrypt$${N}$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, nStr, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !nStr || !salt || !hash) return false;
  const key = await scrypt(password, salt, 64, { N: Number(nStr) });
  return safeEqual(key.toString('hex'), hash);
}

/** n8n ↔ API istekleri için imza: sha256=HMAC(secret, timestamp + "." + body) */
export function signRequest(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + hmacSha256(secret, `${timestamp}.${body}`);
}

export function verifySignature(secret: string, timestamp: string, body: string, signature: string, maxSkewSec = 300): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > maxSkewSec) return false;
  return safeEqual(signRequest(secret, timestamp, body), signature);
}
