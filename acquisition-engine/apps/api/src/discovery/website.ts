import type { WebsiteFacts } from './types.js';

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

export async function fetchWebsiteFacts(website: string, opts: { timeoutMs: number; fetchFn?: typeof fetch }): Promise<WebsiteFacts> {
  const f = opts.fetchFn ?? fetch;
  const base = website.startsWith('http') ? website : `https://${website}`;
  let origin: string;
  try { origin = new URL(base).origin; } catch { return { fetched: false, has_whatsapp_link: false, has_online_booking: false, has_instagram: false, emails: [], phones: [], error: 'geçersiz url' }; }
  const ctl = () => AbortSignal.timeout(opts.timeoutMs);
  const headers = { 'User-Agent': 'BaysSystemsBot/1.0 (+https://bayssystem.com; iletisim@bayssystem.com)', Accept: 'text/html' };
  try {
    const robots = await f(`${origin}/robots.txt`, { signal: ctl(), headers }).catch(() => null);
    if (robots && robots.ok && robotsDisallowsRoot(await robots.text())) {
      return { fetched: false, url: base, has_whatsapp_link: false, has_online_booking: false, has_instagram: false, emails: [], phones: [], blocked_by_robots: true };
    }
    const res = await f(base, { signal: ctl(), headers, redirect: 'follow' });
    const html = (await res.text()).slice(0, 600_000);
    const facts = extractFacts(html, res.url || base, res.status);
    // İletişim sayfası (varsa) — tek ek istek
    const contactHref = /href=["']([^"']*(iletisim|iletişim|contact)[^"']*)["']/i.exec(html)?.[1];
    if (contactHref && facts.emails.length === 0) {
      try {
        const cu = new URL(contactHref, res.url || base).toString();
        if (cu.startsWith(origin)) {
          const cres = await f(cu, { signal: ctl(), headers });
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
    return { fetched: false, url: base, has_whatsapp_link: false, has_online_booking: false, has_instagram: false, emails: [], phones: [], error: (e as Error).message.slice(0, 200) };
  }
}
