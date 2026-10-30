/** IP yardımcıları: CIDR eşleme ve özel/yerel adres tespiti (bağımlılıksız). */
import { isIP } from 'node:net';

function v4ToInt(ip: string): number | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function v6ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let s = ip;
  if (s.startsWith('[')) s = s.slice(1, -1);
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  // IPv4-mapped (::ffff:1.2.3.4)
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const v4 = v4ToInt(m[2]); if (v4 === null) return null; s = `${m[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`; }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) { const v = parseInt(g || '0', 16); if (Number.isNaN(v) || v < 0 || v > 0xffff) return null; out = (out << 16n) | BigInt(v); }
  return out;
}

/** IPv4-mapped IPv6 adresini IPv4'e indirger ("::ffff:10.0.0.1" → "10.0.0.1"). */
export function normalizeIp(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

export function ipInCidr(ipRaw: string, cidr: string): boolean {
  const ip = normalizeIp(ipRaw);
  const [base, bitsStr] = cidr.split('/');
  const baseN = normalizeIp(base);
  const fam = isIP(ip);
  const famBase = isIP(baseN);
  if (!fam || !famBase || fam !== famBase) return false;
  const bits = bitsStr === undefined ? (fam === 4 ? 32 : 128) : Number(bitsStr);
  if (fam === 4) {
    const a = v4ToInt(ip)!, b = v4ToInt(baseN)!;
    if (bits <= 0) return true;
    const mask = bits >= 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  const a = v6ToBigInt(ip), b = v6ToBigInt(baseN);
  if (a === null || b === null) return false;
  if (bits <= 0) return true;
  const shift = BigInt(128 - Math.min(128, bits));
  return (a >> shift) === (b >> shift);
}

export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c.trim()));
}

/** Özel, yerel, link-local, multicast, belirsiz ve ayrılmış adresler (SSRF koruması için). */
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32'];
const PRIVATE_V6 = ['::/128', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8'];
export function isPrivateAddress(ipRaw: string): boolean {
  const ip = normalizeIp(ipRaw);
  const fam = isIP(ip);
  if (fam === 4) return ipInAnyCidr(ip, PRIVATE_V4);
  if (fam === 6) return ipInAnyCidr(ip, PRIVATE_V6);
  return true; // IP değilse güvenli tarafta kal
}
