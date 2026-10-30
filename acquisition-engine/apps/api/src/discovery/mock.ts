import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveredBusiness, DiscoveryProvider } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(here, '../../fixtures');

/** Sabit fixture verisi döndürür; gerçek veri DEĞİLDİR. */
export class MockDiscoveryProvider implements DiscoveryProvider {
  key = 'mock';
  constructor(private file = path.join(FIXTURES_DIR, 'mock-businesses.json')) {}
  async search(p: { query: string; city: string; sectorKey: string; limit: number }): Promise<DiscoveredBusiness[]> {
    const all = JSON.parse(await readFile(this.file, 'utf8')) as Array<DiscoveredBusiness & { sector_key: string }>;
    return all
      .filter((b) => b.sector_key === p.sectorKey && (!p.city || (b.city ?? '').toLocaleLowerCase('tr-TR') === p.city.toLocaleLowerCase('tr-TR')))
      .slice(0, p.limit)
      .map((b) => ({ ...b, source_key: 'mock' }));
  }
}
