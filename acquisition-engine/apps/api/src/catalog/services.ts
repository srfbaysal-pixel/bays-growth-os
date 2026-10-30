import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from '../db/pool.js';
import type { SectorConfig } from '../sectors/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVICES_FILE = path.resolve(here, '../../../../config/services.json');

export interface ServiceDef { key: string; name: string; description: string; sector_fit: Record<string, number> }

export async function loadServiceCatalog(file = SERVICES_FILE): Promise<{ services: ServiceDef[]; example_price_plans: any[] }> {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function upsertServices(db: Queryable, catalog: { services: ServiceDef[]; example_price_plans?: any[] }, withExamplePlans = true): Promise<void> {
  for (const s of catalog.services) {
    await db.query(
      `INSERT INTO services(key, name, description, sector_fit) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, sector_fit = EXCLUDED.sector_fit, updated_at = now()`,
      [s.key, s.name, s.description, JSON.stringify(s.sector_fit)]
    );
  }
  if (withExamplePlans) {
    for (const p of catalog.example_price_plans ?? []) {
      await db.query(
        `INSERT INTO price_plans(service_key, name, setup_fee_cents, monthly_fee_cents, currency, notes)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (service_key, name) DO NOTHING`,
        [p.service_key, p.name, p.setup_fee_cents, p.monthly_fee_cents, p.currency, p.notes ?? null]
      );
    }
  }
}

export async function listServices(db: Queryable): Promise<ServiceDef[]> {
  const r = await db.query('SELECT key, name, description, sector_fit FROM services WHERE is_active ORDER BY key');
  return r.rows;
}

/**
 * Sektör tercihine ve sinyallere göre en uygun hizmeti seçer.
 * Kural tabanlı; AI'ye bağlı değil (deterministik, test edilebilir).
 */
export function recommendService(sector: SectorConfig, services: ServiceDef[], signalsHit: Set<string>): { service_key: string; reason: string } | null {
  const active = new Set(services.map((s) => s.key));
  // Sinyal → hizmet eşlemesi (genel)
  const boosts: Record<string, string[]> = {
    no_online_booking: ['appointment_lead_management'],
    no_whatsapp_link: ['whatsapp_ai_assistant'],
    has_instagram: ['instagram_dm_automation'],
    low_post_frequency: ['social_content_automation'],
    seasonal_demand: ['appointment_lead_management', 'whatsapp_ai_assistant']
  };
  const score = new Map<string, number>();
  sector.service_preference.forEach((k, i) => {
    if (active.has(k)) score.set(k, (sector.service_preference.length - i) * 2);
  });
  for (const sig of signalsHit) for (const svc of boosts[sig] ?? []) if (active.has(svc)) score.set(svc, (score.get(svc) ?? 0) + 3);
  for (const s of services) {
    const fit = s.sector_fit?.[sector.key] ?? 0;
    score.set(s.key, (score.get(s.key) ?? 0) + fit * 4);
  }
  let best: string | null = null;
  let bestScore = -1;
  for (const [k, v] of score) if (v > bestScore) { best = k; bestScore = v; }
  if (!best) return null;
  const hits = [...signalsHit].filter((s) => (boosts[s] ?? []).includes(best!));
  return { service_key: best, reason: hits.length ? `Sinyaller: ${hits.join(', ')}` : 'Sektör tercihi' };
}
