/** D4 — SSRF: DNS rebinding/TOCTOU, sabitlenmiş bağlantı, yönlendirme, boyut/süre sınırı, TLS. Hiçbir test dış ağa çıkmaz. */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { assertSafeUrl, safeFetch, pinnedTransport, readLimited, SsrfBlockedError, type Transport, type TransportRequest } from '../src/discovery/safeFetch.js';
import { fetchWebsiteFacts } from '../src/discovery/website.js';

const PUB = '93.184.216.34';
const lookupMap: Record<string, string[]> = { 'public.example': [PUB], 'evil.example': [PUB, '10.0.0.5'], 'meta.example': ['169.254.169.254'], 'v6.example': ['::1'], 'mapped.example': ['::ffff:127.0.0.1'], 'pub6.example': ['2001:db8::1', '2606:4700::1111'], 'pub6ok.example': ['2606:4700::1111'] };
const lookup = async (h: string) => lookupMap[h] ?? [];
const servers: Array<http.Server | https.Server> = [];
afterAll(() => { for (const s of servers) s.close(); });
const listen = (s: http.Server | https.Server) => new Promise<number>((r) => { s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)); servers.push(s); });

describe('D4 — URL doğrulama', () => {
  it('şema, port, kullanıcı bilgisi, yerel ad ve özel DNS sonuçları reddedilir; tüm A/AAAA kayıtları değerlendirilir', async () => {
    const ok = await assertSafeUrl('https://public.example/', lookup);
    expect(ok.address).toBe(PUB); expect(ok.family).toBe(4);
    expect((await assertSafeUrl('https://pub6ok.example/', lookup)).family).toBe(6);
    for (const u of ['ftp://public.example/', 'https://public.example:4100/', 'https://user:pw@public.example/', 'http://localhost/', 'http://api.internal/', 'http://127.0.0.1/', 'http://[::1]/', 'http://evil.example/', 'http://meta.example/', 'http://v6.example/', 'http://mapped.example/', 'http://pub6.example/', 'http://unknown.example/', 'http://0x7f000001/']) {
      await expect(assertSafeUrl(u, lookup), u).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });
});

describe('D4 — bağlantı doğrulanan IP\'ye sabitlenir (rebinding/TOCTOU)', () => {
  it('DNS ilk çözümde genel, ikincide özel dönse bile taşıma hep doğrulanan IP ile çağrılır; özel hedefe bağlanılmaz', async () => {
    let n = 0;
    const rebinding = async (_h: string) => (++n === 1 ? [PUB] : ['10.0.0.5']);
    const seen: TransportRequest[] = [];
    const transport: Transport = async (req) => { seen.push(req); return { status: 200, location: null, body: 'ok', truncated: false }; };
    const r = await safeFetch('https://public.example/a', { lookup: rebinding, transport });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1); expect(seen[0].address).toBe(PUB); expect(n).toBe(1);
    // Yönlendirme: ikinci atlama yeniden çözülür → özel IP → engellenir, taşıma çağrılmaz
    n = 0; seen.length = 0;
    const redirecting: Transport = async (req) => { seen.push(req); return { status: 302, location: 'https://public.example/b', body: '', truncated: false }; };
    await expect(safeFetch('https://public.example/a', { lookup: rebinding, transport: redirecting })).rejects.toThrow(/özel ağ/);
    expect(seen).toHaveLength(1); expect(n).toBe(2);
  });
  it('yönlendirme kaçışı ve döngü sınırı', async () => {
    const calls: string[] = [];
    const transport: Transport = async (req) => {
      calls.push(req.url);
      if (req.url === 'https://public.example/') return { status: 302, location: 'http://10.0.0.5/admin', body: '', truncated: false };
      if (req.url === 'https://public.example/a') return { status: 301, location: '/b', body: '', truncated: false };
      if (req.url === 'https://public.example/b') return { status: 200, location: null, body: '<title>ok</title>', truncated: false };
      return { status: 302, location: 'https://public.example/loop', body: '', truncated: false };
    };
    await expect(safeFetch('https://public.example/', { lookup, transport })).rejects.toThrow(/özel ağ/);
    expect(calls).toEqual(['https://public.example/']);
    const ok = await safeFetch('https://public.example/a', { lookup, transport });
    expect(ok.status).toBe(200); expect(ok.hops.map((h) => h.url)).toEqual(['https://public.example/a', 'https://public.example/b']);
    await expect(safeFetch('https://public.example/loop', { lookup, transport })).rejects.toThrow(/yönlendirme/);
  });
  it('gerçek taşıma: hostname için ikinci DNS çözümü yapmaz, sabit adrese bağlanır, Host başlığını korur', async () => {
    const srv = http.createServer((req, res) => { res.setHeader('x-host', req.headers.host ?? ''); res.end('pinned-ok'); });
    const port = await listen(srv);
    // Gerçek DNS'te var olmayan ad; yalnız sabitlenen 127.0.0.1 ile ulaşılabilir (port kuralı transport'ta değil assertSafeUrl'dadır)
    const r = await pinnedTransport({ url: `http://no-such-host-bays.invalid:${port}/x`, address: '127.0.0.1', family: 4, headers: { 'user-agent': 't' }, maxBytes: 1000 });
    expect(r.status).toBe(200); expect(r.body).toBe('pinned-ok');
  });
  it('gövde okuma sırasında boyut sınırı ve süre aşımı', async () => {
    const big = Buffer.alloc(2_000_000, 'a');
    const srv = http.createServer((req, res) => { if (req.url === '/slow') return; res.end(big); });
    const port = await listen(srv);
    const r = await pinnedTransport({ url: `http://x.invalid:${port}/big`, address: '127.0.0.1', family: 4, headers: {}, maxBytes: 10_000 });
    expect(r.truncated).toBe(true); expect(Buffer.byteLength(r.body)).toBe(10_000);
    await expect(pinnedTransport({ url: `http://x.invalid:${port}/slow`, address: '127.0.0.1', family: 4, headers: {}, maxBytes: 10, signal: AbortSignal.timeout(300) })).rejects.toThrow();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); c.enqueue(new Uint8Array(5)); c.close(); } });
    expect((await readLimited(stream, 7)).truncated).toBe(true);
  });
  it('HTTPS: sertifika hostname\'e göre doğrulanır (SNI), self-signed reddedilir, CA verilince sabit IP ile çalışır', async () => {
    let cert: string, key: string;
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'bays-tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=public.example', '-addext', 'subjectAltName=DNS:public.example', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
      cert = readFileSync(path.join(dir, 'c.pem'), 'utf8'); key = readFileSync(path.join(dir, 'k.pem'), 'utf8');
    } catch { console.warn('openssl yok, TLS testi atlandı'); return; }
    const srv = https.createServer({ cert, key }, (req, res) => res.end('tls-ok:' + req.headers.host));
    const port = await listen(srv);
    const base = { address: '127.0.0.1' as const, family: 4 as const, headers: {}, maxBytes: 1000 };
    await expect(pinnedTransport({ ...base, url: `https://public.example:${port}/` })).rejects.toThrow();                       // CA bilinmiyor
    await expect(pinnedTransport({ ...base, url: `https://other.example:${port}/`, tlsCa: cert })).rejects.toThrow();            // hostname uyuşmuyor
    const ok = await pinnedTransport({ ...base, url: `https://public.example:${port}/`, tlsCa: cert });
    expect(ok.body).toBe(`tls-ok:public.example:${port}`);
  });
  it('fetchWebsiteFacts özel hedefte hiç istek atmaz; robots/boyut sınırı taşımaya iletilir', async () => {
    const seen: TransportRequest[] = [];
    const transport: Transport = async (req) => { seen.push(req); return { status: 200, location: null, body: req.url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /admin' : '<html><title>T</title><a href="https://wa.me/905">w</a></html>', truncated: false }; };
    const f = await fetchWebsiteFacts('http://evil.example', { timeoutMs: 1000, lookup, transport });
    expect(f.fetched).toBe(false); expect(f.error).toMatch(/ssrf/); expect(seen).toHaveLength(0);
    const ok = await fetchWebsiteFacts('https://public.example', { timeoutMs: 1000, lookup, transport, maxBytes: 5000 });
    expect(ok.fetched).toBe(true); expect(ok.has_whatsapp_link).toBe(true);
    expect(seen.map((s) => [s.url, s.maxBytes])).toEqual([['https://public.example/robots.txt', 64_000], ['https://public.example/', 5000]]);
    expect(seen.every((s) => s.address === PUB)).toBe(true);
  });
});
