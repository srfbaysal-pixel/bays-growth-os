import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, closeTestPool } from './helpers.js';
import { upsertBusiness, isExcluded } from '../src/discovery/pipeline.js';
import { getSector } from '../src/sectors/loader.js';
import { mapPlaces } from '../src/discovery/places.js';
import type pg from 'pg';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(closeTestPool);

describe('lead keşfi ve mükerrer önleme', () => {
  it('aynı işletme farklı yazımla gelirse birleştirilir', async () => {
    const a = await upsertBusiness(pool, 'education', { source_key: 'mock', external_id: 'p-1', name: 'Mavi Dil Kursu', website: 'https://mavidil.example', phone: '0212 555 01 01', city: 'İstanbul' });
    const b = await upsertBusiness(pool, 'education', { source_key: 'csv_import', name: 'MAVİ DİL KURSU LTD. ŞTİ.', website: 'https://www.mavidil.example/', city: 'İstanbul' });
    const c = await upsertBusiness(pool, 'education', { source_key: 'manual', name: 'Mavi Dil', phone: '+90 212 555 0101', city: 'Ankara' });
    const d = await upsertBusiness(pool, 'education', { source_key: 'manual', name: 'Mavi Dil Kursu', city: 'İstanbul' });
    expect(a.created).toBe(true);
    expect(b.id).toBe(a.id); expect(b.merged).toBe(true);
    expect(c.id).toBe(a.id);
    expect(d.id).toBe(a.id);
    expect(Number((await pool.query('SELECT COUNT(*) n FROM businesses')).rows[0].n)).toBe(1);
  });
  it('aynı place id ile tekrar eklenemez (unique)', async () => {
    const x = await upsertBusiness(pool, 'beauty', { source_key: 'google_places', external_id: 'place-x', name: 'Salon X', city: 'İzmir' });
    const y = await upsertBusiness(pool, 'beauty', { source_key: 'google_places', external_id: 'place-x', name: 'Salon X Yeni', city: 'İzmir' });
    expect(y.id).toBe(x.id);
    await expect(pool.query(`INSERT INTO businesses(sector_key,name,normalized_name,dedup_key,google_place_id) VALUES ('beauty','z','z','zzz','place-x')`)).rejects.toThrow(/unique|duplicate/i);
  });
  it('hariç tutma kalıpları uygulanır', async () => {
    const clinic = (await getSector(pool, 'clinic'))!;
    expect(isExcluded(clinic, 'Ankara Devlet Hastanesi Diş Birimi')).toBe(true);
    expect(isExcluded(clinic, 'Gülüş Diş Kliniği')).toBe(false);
  });
  it('Places yanıtını normalize eder ve kapalı işletmeleri eler', () => {
    const out = mapPlaces([
      { id: 'a', displayName: { text: 'A Kuaför' }, formattedAddress: 'x', websiteUri: 'https://a.example', rating: 4.5, userRatingCount: 30, businessStatus: 'OPERATIONAL', addressComponents: [{ longText: 'İzmir', types: ['administrative_area_level_1'] }] },
      { id: 'b', displayName: { text: 'B' }, businessStatus: 'CLOSED_PERMANENTLY' }
    ], 'İstanbul');
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe('İzmir');
    expect(out[0].external_id).toBe('a');
  });
});
