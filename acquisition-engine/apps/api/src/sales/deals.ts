import type { Queryable } from '../db/pool.js';

export const STAGES = ['new', 'contacted', 'interested', 'meeting', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
const RANK = Object.fromEntries(STAGES.map((s, i) => [s, i])) as Record<Stage, number>;

/** İşletme için açık fırsat yoksa oluşturur; varsa aşamayı yalnız ileri taşır. */
export async function ensureDeal(db: Queryable, businessId: string, init: { stage: Stage; service_key?: string | null; source?: string | null }): Promise<string> {
  const open = (await db.query(`SELECT id, stage FROM deals WHERE business_id = $1 AND stage NOT IN ('won','lost') LIMIT 1`, [businessId])).rows[0];
  if (open) {
    if (RANK[init.stage] > RANK[open.stage as Stage]) await db.query('UPDATE deals SET stage = $2 WHERE id = $1', [open.id, init.stage]);
    return open.id;
  }
  const r = await db.query(
    `INSERT INTO deals(business_id, stage, service_key, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [businessId, init.stage, init.service_key ?? null, init.source ?? null]
  );
  if (r.rows[0]) return r.rows[0].id;
  return (await db.query(`SELECT id FROM deals WHERE business_id = $1 AND stage NOT IN ('won','lost') LIMIT 1`, [businessId])).rows[0].id;
}

export async function moveDealStage(db: Queryable, businessId: string, stage: Stage, reason?: string): Promise<void> {
  await db.query(
    `UPDATE deals SET stage = $2, lost_reason = CASE WHEN $2 = 'lost' THEN $3 ELSE lost_reason END,
            closed_at = CASE WHEN $2 IN ('won','lost') THEN now() ELSE NULL END
      WHERE business_id = $1 AND stage NOT IN ('won','lost')`,
    [businessId, stage, reason ?? null]
  );
}

export async function setDealStage(db: Queryable, dealId: string, stage: Stage, patch: { value_cents?: number | null; lost_reason?: string | null; service_key?: string | null } = {}): Promise<void> {
  await db.query(
    `UPDATE deals SET stage = $2, value_cents = COALESCE($3, value_cents), lost_reason = COALESCE($4, lost_reason), service_key = COALESCE($5, service_key),
            closed_at = CASE WHEN $2 IN ('won','lost') THEN now() ELSE NULL END WHERE id = $1`,
    [dealId, stage, patch.value_cents ?? null, patch.lost_reason ?? null, patch.service_key ?? null]
  );
  if (stage === 'won') await db.query(`UPDATE businesses b SET status = 'customer' FROM deals d WHERE d.id = $1 AND b.id = d.business_id`, [dealId]);
}
