import type { DiscoveredBusiness, DiscoveryProvider } from './types.js';
import type { Queryable } from '../db/pool.js';
import { dayBucket } from '../lib/normalize.js';

/**
 * Google Places API (New) — Text Search.
 * Belge: https://developers.google.com/maps/documentation/places/web-service/text-search
 * Maliyet koruması: günlük istek sayacı DB'de tutulur (email_quota_usage tablosu provider='google_places').
 * Politika notu: Places verisi 30 günden uzun önbelleklenemez (place id hariç); iş kaydı
 * yenilenmeden önce yeniden çekilmelidir. Bu kural docs/INTEGRATION_CHECKLIST.md'de izlenir.
 */
export class GooglePlacesProvider implements DiscoveryProvider {
  key = 'google_places';
  constructor(private opts: { apiKey: string; dailyLimit: number; db: Queryable; fetchFn?: typeof fetch; endpoint?: string }) {}

  private async consumeQuota(): Promise<boolean> {
    const r = await this.opts.db.query(
      `INSERT INTO email_quota_usage(bucket, provider, sent_count) VALUES ($1, 'google_places', 1)
       ON CONFLICT (bucket, provider) DO UPDATE SET sent_count = email_quota_usage.sent_count + 1
       RETURNING sent_count`,
      [dayBucket()]
    );
    return Number(r.rows[0].sent_count) <= this.opts.dailyLimit;
  }

  async search(p: { query: string; city: string; sectorKey: string; limit: number }): Promise<DiscoveredBusiness[]> {
    if (!(await this.consumeQuota())) throw new Error('Google Places günlük istek limiti aşıldı (GOOGLE_PLACES_DAILY_LIMIT)');
    const f = this.opts.fetchFn ?? fetch;
    const res = await f(this.opts.endpoint ?? 'https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.opts.apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.types,places.addressComponents,places.googleMapsUri,places.businessStatus'
      },
      body: JSON.stringify({ textQuery: `${p.query} ${p.city}`.trim(), languageCode: 'tr', regionCode: 'TR', pageSize: Math.min(p.limit, 20) })
    });
    if (!res.ok) throw new Error(`Google Places hatası ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as any;
    return mapPlaces(data.places ?? [], p.city);
  }
}

export function mapPlaces(places: any[], fallbackCity: string): DiscoveredBusiness[] {
  return places
    .filter((pl) => !pl.businessStatus || pl.businessStatus === 'OPERATIONAL')
    .map((pl) => {
      const comps: any[] = pl.addressComponents ?? [];
      const find = (t: string) => comps.find((c) => (c.types ?? []).includes(t))?.longText ?? null;
      return {
        source_key: 'google_places',
        external_id: pl.id,
        name: pl.displayName?.text ?? '',
        website: pl.websiteUri ?? null,
        phone: pl.internationalPhoneNumber ?? pl.nationalPhoneNumber ?? null,
        city: find('administrative_area_level_1') ?? fallbackCity,
        district: find('administrative_area_level_2') ?? find('sublocality') ?? null,
        address: pl.formattedAddress ?? null,
        rating: pl.rating ?? null,
        review_count: pl.userRatingCount ?? null,
        types: pl.types ?? [],
        evidence_url: pl.googleMapsUri ?? null
      } satisfies DiscoveredBusiness;
    })
    .filter((b) => b.name);
}
