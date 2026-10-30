import type { Queryable } from '../db/pool.js';
import type { SectorConfig } from '../sectors/types.js';

export const SCORING_MODEL_VERSION = 'rules-v1';

export interface EvidenceRow { kind: 'observation' | 'inference'; field: string; value: unknown; confidence: number; source_key: string }
export interface ScoreResult { score: number; hits: string[]; breakdown: Record<string, { weight: number; hit: boolean; basis: 'observation' | 'inference' | 'none'; label: string }> }

/**
 * Saf fonksiyon: sektör sinyalleri × kanıt → 0-100 puan.
 * - Gözlem (observation) her sinyali besleyebilir.
 * - Çıkarım (inference) yalnız inference_ok=true sinyalleri, güvenle ağırlıklandırılarak besler.
 */
export function computeScore(sector: SectorConfig, evidence: EvidenceRow[]): ScoreResult {
  const byField = new Map<string, EvidenceRow[]>();
  for (const e of evidence) byField.set(e.field, [...(byField.get(e.field) ?? []), e]);
  const totalWeight = Object.values(sector.signals).reduce((a, s) => a + s.weight, 0) || 1;
  let raw = 0;
  const hits: string[] = [];
  const breakdown: ScoreResult['breakdown'] = {};
  for (const [key, sig] of Object.entries(sector.signals)) {
    const rows = byField.get(sig.evidence_field) ?? [];
    const obs = rows.find((r) => r.kind === 'observation');
    const inf = rows.find((r) => r.kind === 'inference');
    let hit = false;
    let basis: 'observation' | 'inference' | 'none' = 'none';
    let factor = 1;
    if (obs) { hit = obs.value === sig.expect; basis = 'observation'; }
    else if (inf && sig.inference_ok) { hit = inf.value === sig.expect; basis = 'inference'; factor = Math.min(1, Math.max(0, Number(inf.confidence))); }
    if (hit) { raw += sig.weight * factor; hits.push(key); }
    breakdown[key] = { weight: sig.weight, hit, basis, label: sig.label };
  }
  return { score: Math.round((raw / totalWeight) * 100), hits, breakdown };
}

export async function loadEvidence(db: Queryable, businessId: string): Promise<EvidenceRow[]> {
  const r = await db.query('SELECT kind, field, value, confidence, source_key FROM research_evidence WHERE business_id = $1', [businessId]);
  return r.rows.map((x) => ({ ...x, confidence: Number(x.confidence) }));
}

export async function scoreBusiness(db: Queryable, sector: SectorConfig, businessId: string): Promise<ScoreResult & { qualified: boolean }> {
  const ev = await loadEvidence(db, businessId);
  const res = computeScore(sector, ev);
  const qualified = res.score >= sector.qualification_threshold;
  await db.query('INSERT INTO lead_scores(business_id, score, breakdown, model_version) VALUES ($1,$2,$3,$4)', [businessId, res.score, JSON.stringify(res.breakdown), SCORING_MODEL_VERSION]);
  await db.query(
    `UPDATE businesses SET lead_score = $2, score_breakdown = $3,
       status = CASE WHEN status IN ('new','qualified','disqualified') THEN (CASE WHEN $4 THEN 'qualified' ELSE 'disqualified' END) ELSE status END
     WHERE id = $1`,
    [businessId, res.score, JSON.stringify(res.breakdown), qualified]
  );
  return { ...res, qualified };
}
