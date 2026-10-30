/**
 * D4 — SSRF'ye karşı güvenli HTTP alımı.
 *  1) URL doğrulanır (şema/port/kullanıcı bilgisi/yerel ad).
 *  2) Tüm A/AAAA kayıtları çözülür; herhangi biri özel/yerel/link-local/mapped ise istek reddedilir.
 *  3) Bağlantı DOĞRULANAN IP'ye sabitlenir: taşıma katmanına ikinci bir DNS çözümü yaptırılmaz
 *     (undici Agent'ın `connect.lookup` kancası sabit adresi döndürür). TLS SNI ve sertifika doğrulaması
 *     ana makine ADINA göre yapılmaya devam eder (servername = hostname).
 *  4) Yönlendirmeler elle izlenir (en çok 3); her atlama 1–3 adımlarından yeniden geçer.
 *  5) Gövde okunurken boyut sınırı uygulanır (bellek alıp sonra kesme yok); süre aşımı sinyalle.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateAddress } from '../lib/ip.js';

export type LookupFn = (hostname: string) => Promise<string[]>;
export class SsrfBlockedError extends Error {}

export const defaultLookup: LookupFn = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface TransportRequest { url: string; address: string; family: 4 | 6; headers: Record<string, string>; signal?: AbortSignal; maxBytes: number; tlsCa?: string | Buffer }
export interface TransportResponse { status: number; location: string | null; body: string; truncated: boolean }
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export async function assertSafeUrl(url: string, lookup: LookupFn = defaultLookup): Promise<{ url: URL; address: string; family: 4 | 6 }> {
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
  const address = addrs[0];
  return { url: u, address, family: isIP(address) === 6 ? 6 : 4 };
}

/** Yanıt gövdesini en çok maxBytes okur; aşımda akışı iptal eder. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0; let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) { chunks.push(value.subarray(0, maxBytes - total)); total = maxBytes; truncated = true; await reader.cancel().catch(() => undefined); break; }
      chunks.push(value); total += value.byteLength;
    }
  } finally { reader.releaseLock?.(); }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Gerçek taşıma: doğrulanan IP'ye sabitlenmiş undici Agent. Her istek için ayrı Agent açılır ve kapatılır. */
export const pinnedTransport: Transport = async (req) => {
  const lookup = (hostname: string, options: any, cb: any) => {
    // Node net/tls: options.all ise dizi, değilse (address, family) bekler. DNS'e asla gidilmez.
    const cbFn = typeof options === 'function' ? options : cb;
    const all = typeof options === 'object' && options?.all;
    void hostname;
    return all ? cbFn(null, [{ address: req.address, family: req.family }]) : cbFn(null, req.address, req.family);
  };
  const agent = new Agent({ connect: { lookup: lookup as any, timeout: 10_000, ...(req.tlsCa ? { ca: req.tlsCa } : {}) }, maxRedirections: 0 } as any);
  try {
    const res = await undiciFetch(req.url, { method: 'GET', headers: req.headers, redirect: 'manual', signal: req.signal, dispatcher: agent } as any);
    const { text, truncated } = await readLimited(res.body as any, req.maxBytes);
    return { status: res.status, location: res.headers.get('location'), body: text, truncated };
  } finally { await agent.close().catch(() => undefined); }
};

export interface SafeFetchOptions { lookup?: LookupFn; transport?: Transport; signal?: AbortSignal; headers?: Record<string, string>; maxRedirects?: number; maxBytes?: number; tlsCa?: string | Buffer }
export interface SafeFetchResult { status: number; url: string; body: string; truncated: boolean; hops: Array<{ url: string; address: string }> }

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const transport = opts.transport ?? pinnedTransport;
  const maxRedirects = opts.maxRedirects ?? 3;
  const hops: SafeFetchResult['hops'] = [];
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url: u, address, family } = await assertSafeUrl(current, opts.lookup);
    hops.push({ url: u.toString(), address });
    const res = await transport({ url: u.toString(), address, family, headers: opts.headers ?? {}, signal: opts.signal, maxBytes: opts.maxBytes ?? 600_000, tlsCa: opts.tlsCa });
    if (res.status >= 300 && res.status < 400 && res.location) { current = new URL(res.location, u).toString(); continue; }
    return { status: res.status, url: u.toString(), body: res.body, truncated: res.truncated, hops };
  }
  throw new SsrfBlockedError('çok fazla yönlendirme');
}
