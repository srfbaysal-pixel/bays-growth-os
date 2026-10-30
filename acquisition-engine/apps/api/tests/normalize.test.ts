import { describe, it, expect } from 'vitest';
import { normalizeName, normalizePhoneTR, normalizeEmail, extractDomain, buildDedupKey } from '../src/lib/normalize.js';
import { parseCsv, csvToBusinesses } from '../src/discovery/csv.js';
import { extractFacts, robotsDisallowsRoot } from '../src/discovery/website.js';

describe('normalize', () => {
  it('ad normalizasyonu Türkçe ve ticari ekleri sadeleştirir', () => {
    expect(normalizeName('Mavi Dil Kursu Ltd. Şti.')).toBe('mavi dil kursu');
    expect(normalizeName('MAVİ DİL KURSU')).toBe('mavi dil kursu');
    expect(normalizeName('Güzellik & Bakım A.Ş.')).toBe('guzellik bakim');
  });
  it('telefonları E.164 yapar', () => {
    expect(normalizePhoneTR('0212 555 01 01')).toBe('+902125550101');
    expect(normalizePhoneTR('+90 (532) 555-11-11')).toBe('+905325551111');
    expect(normalizePhoneTR('212 555 01 01')).toBe('+902125550101');
    expect(normalizePhoneTR('abc')).toBeNull();
  });
  it('e-posta ve alan adı', () => {
    expect(normalizeEmail(' Info@Mavidil.Example ')).toBe('info@mavidil.example');
    expect(normalizeEmail('bozuk')).toBeNull();
    expect(extractDomain('https://www.mavidil.example/iletisim')).toBe('mavidil.example');
    expect(extractDomain('mavidil.example')).toBe('mavidil.example');
    expect(extractDomain('https://instagram.com/x')).toBeNull();
  });
  it('dedup anahtarı öncelik sırasını izler', () => {
    expect(buildDedupKey({ google_place_id: 'p1', domain: 'd', phone_e164: '+9', normalized_name: 'n', city: 'c' })).toBe('place:p1');
    expect(buildDedupKey({ domain: 'd', phone_e164: '+9', normalized_name: 'n', city: 'c' })).toBe('domain:d');
    expect(buildDedupKey({ normalized_name: 'n', city: 'İstanbul' })).toBe('name:n|istanbul');
  });
});

describe('csv', () => {
  it('tırnaklı alanları ayrıştırır', () => {
    const rows = parseCsv('name,website,phone\n"Nur, Güzellik",https://nur.example,"0533 555 12 12"\nX,,\n');
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Nur, Güzellik');
    expect(csvToBusinesses('name,email\nA,a@b.co')[0].email).toBe('a@b.co');
  });
});

describe('website facts', () => {
  it('WhatsApp, randevu, instagram, e-posta çıkarır', () => {
    const f = extractFacts(`<html><head><title>Test</title></head><body><a href="https://wa.me/905">wa</a><a href="https://instagram.com/testsalon">ig</a><button>Online Randevu Al</button>info@test.example</body></html>`, 'https://test.example', 200);
    expect(f.has_whatsapp_link).toBe(true);
    expect(f.has_online_booking).toBe(true);
    expect(f.instagram_handle).toBe('testsalon');
    expect(f.emails).toEqual(['info@test.example']);
  });
  it('robots.txt tam yasak algılanır', () => {
    expect(robotsDisallowsRoot('User-agent: *\nDisallow: /')).toBe(true);
    expect(robotsDisallowsRoot('User-agent: *\nDisallow: /admin')).toBe(false);
    expect(robotsDisallowsRoot('User-agent: Googlebot\nDisallow: /')).toBe(false);
  });
});
