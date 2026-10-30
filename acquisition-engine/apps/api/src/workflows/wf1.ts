import type pg from 'pg';
import type { Config } from '../config.js';
import type { AiProvider } from '../ai/types.js';
import type { DiscoveryProvider } from '../discovery/types.js';
import { fetchWebsiteFacts } from '../discovery/website.js';
import { isExcluded, recordDiscoveryObservations, recordEvidence, recordWebsiteObservations, upsertBusiness, upsertContact } from '../discovery/pipeline.js';
import { getSector } from '../sectors/loader.js';
import { scoreBusiness } from '../scoring/score.js';
import { heartbeat } from '../health/status.js';
import { log } from '../lib/logger.js';

export interface Wf1Stats { sector: string; city: string; found: number; created: number; merged: number; excluded: number; websites_fetched: number; inferred: number; qualified: number; errors: string[] }

/**
 * WF1 — Lead Discovery & Qualification.
 * n8n bu fonksiyonu /internal/wf1/run ile tetikler; CLI de çağırabilir.
 */
export async function runWf1(pool: pg.Pool, cfg: Config, deps: { discovery: DiscoveryProvider; ai: AiProvider; fetchFn?: typeof fetch }, params: { sectorKey: string; city: string; limitPerQuery?: number; targetQualified?: number; runId: string }): Promise<Wf1Stats> {
  const stats: Wf1Stats = { sector: params.sectorKey, city: params.city, found: 0, created: 0, merged: 0, excluded: 0, websites_fetched: 0, inferred: 0, qualified: 0, errors: [] };
  await heartbeat(pool, 'wf1_discovery', params.runId, 'running', stats);
  try {
    const sector = await getSector(pool, params.sectorKey);
    if (!sector) throw new Error(`Sektör yok: ${params.sectorKey}`);
    const inferenceFields = Object.values(sector.signals).filter((s) => s.inference_ok).map((s) => s.evidence_field);
    const seen = new Set<string>();
    for (const query of sector.discovery.queries) {
      if (params.targetQualified && stats.qualified >= params.targetQualified) break;
      let results;
      try { results = await deps.discovery.search({ query, city: params.city, sectorKey: sector.key, limit: params.limitPerQuery ?? 20 }); }
      catch (e) { stats.errors.push(`${query}: ${(e as Error).message}`); continue; }
      for (const b of results) {
        stats.found++;
        if (isExcluded(sector, b.name)) { stats.excluded++; continue; }
        const up = await upsertBusiness(pool, sector.key, b);
        if (seen.has(up.id)) continue;
        seen.add(up.id);
        up.created ? stats.created++ : stats.merged++;
        await recordDiscoveryObservations(pool, up.id, b);
        if (b.email) await upsertContact(pool, up.id, { email: b.email, source_key: b.source_key, is_primary: true });

        const row = (await pool.query('SELECT website, name, city, rating, review_count FROM businesses WHERE id = $1', [up.id])).rows[0];
        let siteTitle: string | null = null;
        if (cfg.WEBSITE_FETCH_ENABLED && row.website) {
          const facts = await fetchWebsiteFacts(row.website, { timeoutMs: cfg.WEBSITE_FETCH_TIMEOUT_MS, fetchFn: deps.fetchFn });
          await recordWebsiteObservations(pool, up.id, facts);
          if (facts.fetched) { stats.websites_fetched++; siteTitle = facts.title ?? null; }
        } else {
          await recordEvidence(pool, up.id, b.source_key, 'observation', 'has_whatsapp_link', false, 0.5, b.evidence_url);
        }
        if (inferenceFields.length) {
          const obs = (await pool.query(`SELECT field, value, source_key FROM research_evidence WHERE business_id = $1 AND kind = 'observation'`, [up.id])).rows;
          try {
            const inf = await deps.ai.infer({ sectorKey: sector.key, business: { name: row.name, website: row.website, city: row.city, rating: row.rating, review_count: row.review_count }, observations: obs.map((o) => ({ field: o.field, value: o.value, source: o.source_key })), siteTitle, candidateFields: inferenceFields });
            for (const i of inf.inferences) { await recordEvidence(pool, up.id, 'ai_inference', 'inference', i.field, i.value, i.confidence, null); stats.inferred++; }
          } catch (e) { stats.errors.push(`inference ${row.name}: ${(e as Error).message}`); }
        }
        const sc = await scoreBusiness(pool, sector, up.id);
        if (sc.qualified) stats.qualified++;
        // Kanal izni başlangıç kaydı: kamuya açık işletme iletişimi → 'unknown' (hukuki doğrulama gerekli)
        await pool.query(`INSERT INTO channel_permissions(business_id, channel, status, basis) VALUES ($1,'email','unknown','public_business_contact') ON CONFLICT DO NOTHING`, [up.id]);
      }
    }
    await heartbeat(pool, 'wf1_discovery', params.runId, stats.errors.length ? 'partial' : 'succeeded', stats);
  } catch (e) {
    stats.errors.push((e as Error).message);
    await heartbeat(pool, 'wf1_discovery', params.runId, 'failed', stats, (e as Error).message);
    log.error('wf1 hata', { error: (e as Error).message });
  }
  return stats;
}
