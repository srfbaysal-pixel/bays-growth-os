import type { Config } from './config.js';
import { getPool } from './db/pool.js';
import { makeAiProvider } from './ai/index.js';
import { makeEmailProvider } from './email/index.js';
import { MockDiscoveryProvider } from './discovery/mock.js';
import { GooglePlacesProvider } from './discovery/places.js';
import type { AppContext } from './http/context.js';
import type { DiscoveryProvider } from './discovery/types.js';

export function buildContext(cfg: Config, over: Partial<AppContext> = {}): AppContext {
  const pool = over.pool ?? getPool(cfg.DATABASE_URL);
  let discovery: DiscoveryProvider;
  if (cfg.DISCOVERY_PROVIDER === 'google_places') {
    if (!cfg.GOOGLE_PLACES_API_KEY) throw new Error('DISCOVERY_PROVIDER=google_places için GOOGLE_PLACES_API_KEY gerekli');
    discovery = new GooglePlacesProvider({ apiKey: cfg.GOOGLE_PLACES_API_KEY, dailyLimit: cfg.GOOGLE_PLACES_DAILY_LIMIT, db: pool, fetchFn: over.fetchFn });
  } else discovery = new MockDiscoveryProvider();
  return { cfg, pool, ai: over.ai ?? makeAiProvider(cfg, pool, over.fetchFn), email: over.email ?? makeEmailProvider(cfg), discovery: over.discovery ?? discovery, fetchFn: over.fetchFn };
}
