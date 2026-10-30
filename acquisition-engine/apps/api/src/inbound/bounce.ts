/**
 * K4 — DSN/bounce e-postalarından güvenli bilgi çıkarımı.
 * Standart DSN (RFC 3464) alanları ve yaygın serbest metin kalıpları taranır.
 */
import { normalizeEmail } from '../lib/normalize.js';

export interface BounceInfo { recipients: string[]; messageIds: string[]; isDsn: boolean }

const RECIPIENT_HEADERS = /(?:Final-Recipient|Original-Recipient|X-Failed-Recipients|X-Original-To)\s*:\s*(?:rfc822;\s*)?([^\s;,<>]+@[^\s;,<>]+)/gi;
const ANGLE_ADDR = /<([^\s<>@]+@[^\s<>]+)>/g;
const FAILED_LINE = /(?:^|\n)\s*([^\s<>:]+@[^\s<>:]+)\s*(?::|\s)\s*(?:host|unknown|user unknown|mailbox|does not exist|rejected|550|552|553|554)/gi;

export function extractBounceInfo(text: string, replyDomain: string, headers?: Record<string, unknown> | null): BounceInfo {
  const body = text ?? '';
  const recipients = new Set<string>();
  const messageIds = new Set<string>();
  for (const m of body.matchAll(RECIPIENT_HEADERS)) { const e = normalizeEmail(m[1]); if (e) recipients.add(e); }
  for (const m of body.matchAll(FAILED_LINE)) { const e = normalizeEmail(m[1]); if (e) recipients.add(e); }
  if (recipients.size === 0) for (const m of body.matchAll(ANGLE_ADDR)) { const e = normalizeEmail(m[1]); if (e && !/mailer-daemon|postmaster/i.test(e)) recipients.add(e); }
  // Bizim Message-ID biçimimiz: <uuid@replyDomain>
  const dom = replyDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`<([0-9a-f-]{36}@${dom})>`, 'gi');
  for (const m of body.matchAll(idRe)) messageIds.add(`<${m[1]}>`);
  const h = headers ?? {};
  for (const k of ['x-failed-recipients', 'x-original-to']) { const e = normalizeEmail(String(h[k] ?? '')); if (e) recipients.add(e); }
  // DSN postaları bizim reply+token adresimize değil, From adresine gelir; token'ı alıcı sanma
  for (const r of [...recipients]) if (/^reply\+/.test(r)) recipients.delete(r);
  const isDsn = /content-type:\s*multipart\/report|report-type=delivery-status|delivery status notification|mail delivery/i.test(body) || recipients.size > 0;
  return { recipients: [...recipients], messageIds: [...messageIds], isDsn };
}
