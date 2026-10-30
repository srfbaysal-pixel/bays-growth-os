import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { WebsiteFacts } from './types.js';
import { isPrivateAddress } from '../lib/ip.js';

const BOOKING_PATTERNS = /(online\s*randevu|randevu\s*al|hemen\s*randevu|online\s*kay[ıi]t|[oö]n\s*kay[ıi]t\s*formu|calendly|setmore|randevu\.|booking|appointment|rezervasyon)/i;
const WHATSAPP_PATTERNS = /(wa\.me\/|api\.whatsapp\.com|whatsapp:\/\/|web\.whatsapp\.com)/i;
const IG_PATTERN = /instagram\.com\/([A-Za-z0-9_.]{2,30})/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_PATTERN = /(\+90|0)?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/g;

export function extractFacts(html: string, url: string, status: number): WebsiteFacts {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 200) ?? null;
  const ig = [...html.matchAll(IG_PATTERN)].map((m) => m[1]).filter((h) => !['p', 'reel', 'explore', 'accounts', 'share'].includes(h));
  const emails = [...new Set((text.match(EMAIL_PATTERN) ?? []).map((e) => e.toLowerCase()).filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e) && !/example\.|sentry|wixpress/.test(e)))].slice(0, 5);
  const phones = [...new Set((text.replace(/<[^>]+>/g, ' ').match(PHONE_PATTERN) ?? []).map((p) => p.trim()))].slice(0, 5);
  return {
    fetched: true,
    url,
    status,
    title,
    has_whatsapp_link: WHATSAPP_PATTERNS.test(html),
    has_online_booking: BOOKING_PATTERNS.test(text),
    has_instagram: ig.length > 0,
    instagram_handle: ig[0] ?? null,
    emails,
    phones
  };
}

/** robots.txt'de tüm ajanlar için kök yol yasaklı mı? Basit, muhafazakâr kontrol. */
export function robotsDisallowsRoot(robotsTxt: string): boolean {
  let applies = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    if (k.toLowerCase() === 'user-agent') applies = v === '*';
    else if (applies && k.toLowerCase() === 'disallow' && (v === '/' )) return true;
  }
  return false;
}

export type LookupFn = (hostname: string) => Promise<string[]>;
export class SsrfBlockedError extends Error {}

const defaultLookup: LookupFn = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Ö2 — SSRF koruması. Bir URL yalnız şu şartlarda alınır:
 *  - http/https, port 80/443 (veya şemanın varsayılanı), kullanıcı bilgisi yok,
 *  - ana makine adı IP ise veya DNS çözümü ÖZEL/yerel/link-local/multicast adrese düşüyorsa reddedilir
 *    (tüm A/AAAA kayıtları kontrol edilir; DNS rebinding'e karşı her istekte yeniden çözülür),
 *  - yönlendirmeler elle izlenir (en çok 3) ve her hedef aynı kurallarla yeniden doğrulanır.
 */
export async function assertSafeUrl(url: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try { u = new URL(url); } catch { throw new SsrfBlockedError('geçersiz url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfBlockedError(`şema reddedildi: ${u.protocol}`);
  if (u.username || u.password) throw new SsrfBlockedError('kullanıcı bilgisi içeren url');
  if (u.port && u.port !== '80' && u.port !== '443') throw new SsrfBlockedError(`port reddedildi: ${u.port}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new SsrfBlockedError(`ana makine reddedildi: ${host}`);
  const addrs = isIP(host) ? [host] : await lookup(host).catch(() => [] as string[]);
  if (addrs.length === 0) throw new SsrfBlockedError(`dns çözülemedi: ${host}`);
  for (const a of addrs) if (isPrivateAddress(a)) throw new SsrfBlockedError(`özel ağ adresi reddedildi: ${host} → ${a}`);
  return u;
}

/** Yönlendirmeleri elle izleyen, her atlamayı doğrulayan güvenli GET. */
export async function safeFetch(url: string, init: { fetchFn?: typeof fetch; lookup?: LookupFn; signal?: AbortSignal; headers?: Record<string, string>; maxRedirects?: number }): Promise<Response> {
  const f = init.fetchFn ?? fetch;
  let current = url;
  for (let hop = 0; hop <= (init.maxRedirects ?? 3); hop++) {
    const u = await assertSafeUrl(current, init.lookup);
    const res = await f(u.toString(), { method: 'GET', signal: init.signal, headers: init.headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, u).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError('çok fazla yönlendirme');
}

export async function fetchWebsiteFacts(website: string, opts: { timeoutMs: number; fetchFn?: typeof fetch; lookup?: LookupFn }): Promise<WebsiteFacts> {
  const base = website.startsWith('http') ? website : `https://${website}`;
  let origin: string;
  try { origin = (await assertSafeUrl(base, opts.lookup)).origin; }
  catch (e) { return { fetched: false, url: base, has_whatsapp_link: false, has_online_booking: false, has_instagram: false, emails: [], phones: [], error: e instanceof SsrfBlockedError ? `ssrf: ${e.message}` : 'geçersiz url' }; }
  const ctl = () => AbortSignal.timeout(opts.timeoutMs);
  const headers = { 'User-Agent': 'BaysSystemsBot/1.0 (+https://bayssystem.com; iletisim@bayssystem.com)', Accept: 'text/html' };
  const sf = (u: string) => safeFetch(u, { fetchFn: opts.fetchFn, lookup: opts.lookup, signal: ctl(), headers });
  try {
    const robots = await sf(`${origin}/robots.txt`).catch(() => null);
    if (robots && robots.ok && robotsDisallowsRoot(await robots.text())) {
      return { fetched: false, url: base, has_whatsapp_link: false, has_online_booking: false, has_instagram: false, emails: [], phones: [], blocked_by_robots: true };
    }
    const res = await sf(base);
    const html = (await res.text()).slice(0, 600_000);
    const facts = extractFacts(html, res.url || base, res.status);
    // İletişim sayfası (varsa) — tek ek istek, aynı origin ve aynı SSRF kuralları
    const contactHref = /href=["']([^"']*(iletisim|iletişim|contact)[^"']*)["']/i.exec(html)?.[1];
    if (contactHref && facts.emails.length === 0) {
      try {
        const cu = new URL(contactHref, res.url || base).toString();
        if (cu.startsWith(origin)) {
          const cres = await sf(cu);
          const cfacts = extractFacts((await cres.text()).slice(0, 300_000), cu, cres.status);
          facts.emails = [...new Set([...facts.emails, ...cfacts.emails])];
          facts.phones = [...new Set([...facts.phones, ...cfacts.phones])];
          facts.has_whatsapp_link = facts.has_whatsapp_link || cfacts.has_whatsapp_link;
          facts.has_online_booking = facts.has_online_booking || cfacts.has_online_booking;
          if (!facts.has_instagram && cfacts.has_instagram) { facts.has_instagram = true; facts.instagram_handle = cfacts.instagram_handle; }
        }
      } catch { /* iletişim sayfası opsiyonel */ }
    }
    return facts;
  } catch (e) {
    return { fetched: false, url: base, has_whatsapp_link: false, has_online_booking: false, has_instagram: false, emails: [], phones: [], error: (e instanceof SsrfBlockedError ? 'ssrf: ' : '') + (e as Error).message.slice(0, 200) };
  }
}
