/** Türkçe karakterleri sadeleştirip karşılaştırılabilir ad üretir. */
export function normalizeName(name: string): string {
  return name
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ltd|sti|a\.s|as|san|tic|ve|limited|sirketi|şti)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Türkiye numaralarını E.164'e çevirir; başarısızsa null. */
export function normalizePhoneTR(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('90') && d.length === 12) return '+' + d;
  if (d.startsWith('0') && d.length === 11) return '+90' + d.slice(1);
  if (d.length === 10 && /^[2-5]/.test(d)) return '+90' + d;
  if (d.length >= 10 && d.length <= 15) return '+' + d;
  return null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    // Sosyal/platform alan adları işletme alanı sayılmaz
    if (/(instagram|facebook|linkedin|google|wa\.me|whatsapp|twitter|x)\.com$/.test(host)) return null;
    return host || null;
  } catch {
    return null;
  }
}

export function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

/** Mükerrer anahtar: öncelik sırası place_id > domain > telefon > ad+şehir */
export function buildDedupKey(b: { google_place_id?: string | null; domain?: string | null; phone_e164?: string | null; normalized_name: string; city?: string | null }): string {
  if (b.google_place_id) return `place:${b.google_place_id}`;
  if (b.domain) return `domain:${b.domain}`;
  if (b.phone_e164) return `phone:${b.phone_e164}`;
  return `name:${b.normalized_name}|${(b.city ?? '').toLocaleLowerCase('tr-TR')}`;
}

export function dayBucket(d = new Date()): string {
  return `day:${d.toISOString().slice(0, 10)}`;
}
export function hourBucket(d = new Date()): string {
  return `hour:${d.toISOString().slice(0, 13)}`;
}
