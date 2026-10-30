import type { Queryable } from '../db/pool.js';

export interface DayMetrics {
  leads_discovered: number; leads_qualified: number; drafts_prepared: number; approvals_pending: number; approved: number; rejected: number;
  sent: number; dry_run: number; send_errors: number; bounces: number; replies: number; replies_interested: number; replies_rejected: number; meetings: number;
  quotes_sent: number; quotes_accepted: number; deals_won: number; deals_lost: number; new_subscriptions: number; mrr_cents: number; active_subscriptions: number;
}

/** Gerçek tablolardan hesaplanır; sahte/varsayılan değer yok. */
export async function computeDayMetrics(db: Queryable, day: string, sectorKey: string | null = null): Promise<DayMetrics> {
  const p = [day, sectorKey];
  const sectorJoin = sectorKey ? 'AND b.sector_key = $2' : 'AND ($2::text IS NULL)';
  const q = async (sql: string) => Number((await db.query(sql, p)).rows[0]?.n ?? 0);
  return {
    leads_discovered: await q(`SELECT COUNT(*) n FROM businesses b WHERE b.created_at::date = $1::date ${sectorJoin}`),
    leads_qualified: await q(`SELECT COUNT(DISTINCT ls.business_id) n FROM lead_scores ls JOIN businesses b ON b.id = ls.business_id JOIN sectors s ON s.key = b.sector_key WHERE ls.scored_at::date = $1::date AND ls.score >= (s.config->>'qualification_threshold')::int ${sectorJoin}`),
    drafts_prepared: await q(`SELECT COUNT(*) n FROM message_drafts d JOIN businesses b ON b.id = d.business_id WHERE d.created_at::date = $1::date ${sectorJoin}`),
    approvals_pending: await q(`SELECT COUNT(*) n FROM message_drafts d JOIN businesses b ON b.id = d.business_id WHERE d.status = 'pending_approval' AND $1::date IS NOT NULL ${sectorJoin}`),
    approved: await q(`SELECT COUNT(*) n FROM approval_actions a JOIN message_drafts d ON d.id = a.draft_id JOIN businesses b ON b.id = d.business_id WHERE a.action = 'approve' AND a.created_at::date = $1::date ${sectorJoin}`),
    rejected: await q(`SELECT COUNT(*) n FROM approval_actions a JOIN message_drafts d ON d.id = a.draft_id JOIN businesses b ON b.id = d.business_id WHERE a.action = 'reject' AND a.created_at::date = $1::date ${sectorJoin}`),
    sent: await q(`SELECT COUNT(*) n FROM send_events e JOIN send_jobs j ON j.id = e.send_job_id JOIN businesses b ON b.id = j.business_id WHERE e.event = 'accepted' AND e.occurred_at::date = $1::date ${sectorJoin}`),
    dry_run: await q(`SELECT COUNT(*) n FROM send_events e JOIN send_jobs j ON j.id = e.send_job_id JOIN businesses b ON b.id = j.business_id WHERE e.event = 'dry_run' AND e.occurred_at::date = $1::date ${sectorJoin}`),
    send_errors: await q(`SELECT COUNT(*) n FROM send_events e JOIN send_jobs j ON j.id = e.send_job_id JOIN businesses b ON b.id = j.business_id WHERE e.event = 'error' AND e.occurred_at::date = $1::date ${sectorJoin}`),
    bounces: await q(`SELECT COUNT(*) n FROM send_events e JOIN send_jobs j ON j.id = e.send_job_id JOIN businesses b ON b.id = j.business_id WHERE e.event IN ('bounce','complaint','reject') AND e.occurred_at::date = $1::date ${sectorJoin}`),
    replies: await q(`SELECT COUNT(*) n FROM inbound_messages i LEFT JOIN businesses b ON b.id = i.matched_business_id WHERE i.received_at::date = $1::date AND i.classification NOT IN ('bounce') ${sectorKey ? 'AND b.sector_key = $2' : 'AND ($2::text IS NULL)'}`),
    replies_interested: await q(`SELECT COUNT(*) n FROM inbound_messages i JOIN businesses b ON b.id = i.matched_business_id WHERE i.received_at::date = $1::date AND i.classification IN ('interested','question') ${sectorJoin}`),
    replies_rejected: await q(`SELECT COUNT(*) n FROM inbound_messages i JOIN businesses b ON b.id = i.matched_business_id WHERE i.received_at::date = $1::date AND i.classification = 'rejected' ${sectorJoin}`),
    meetings: await q(`SELECT COUNT(*) n FROM inbound_messages i JOIN businesses b ON b.id = i.matched_business_id WHERE i.received_at::date = $1::date AND i.classification = 'meeting_request' ${sectorJoin}`),
    quotes_sent: await q(`SELECT COUNT(*) n FROM quotes qq JOIN businesses b ON b.id = qq.business_id WHERE qq.sent_at::date = $1::date ${sectorJoin}`),
    quotes_accepted: await q(`SELECT COUNT(*) n FROM quotes qq JOIN businesses b ON b.id = qq.business_id WHERE qq.status = 'accepted' AND qq.decided_at::date = $1::date ${sectorJoin}`),
    deals_won: await q(`SELECT COUNT(*) n FROM deals d JOIN businesses b ON b.id = d.business_id WHERE d.stage = 'won' AND d.closed_at::date = $1::date ${sectorJoin}`),
    deals_lost: await q(`SELECT COUNT(*) n FROM deals d JOIN businesses b ON b.id = d.business_id WHERE d.stage = 'lost' AND d.closed_at::date = $1::date ${sectorJoin}`),
    new_subscriptions: await q(`SELECT COUNT(*) n FROM subscriptions s JOIN businesses b ON b.id = s.business_id WHERE s.created_at::date = $1::date ${sectorJoin}`),
    mrr_cents: await q(`SELECT COALESCE(SUM(s.monthly_fee_cents),0) n FROM subscriptions s JOIN businesses b ON b.id = s.business_id WHERE s.status IN ('active','trial') AND $1::date IS NOT NULL ${sectorJoin}`),
    active_subscriptions: await q(`SELECT COUNT(*) n FROM subscriptions s JOIN businesses b ON b.id = s.business_id WHERE s.status IN ('active','trial') AND $1::date IS NOT NULL ${sectorJoin}`)
  };
}

export async function storeDayMetrics(db: Queryable, day: string): Promise<Record<string, DayMetrics>> {
  const sectors = (await db.query('SELECT key FROM sectors WHERE is_active')).rows.map((r) => r.key as string);
  const out: Record<string, DayMetrics> = {};
  for (const key of ['all', ...sectors]) {
    const m = await computeDayMetrics(db, day, key === 'all' ? null : key);
    await db.query(`INSERT INTO daily_metrics(day, sector_key, metrics) VALUES ($1,$2,$3) ON CONFLICT (day, sector_key) DO UPDATE SET metrics = EXCLUDED.metrics, computed_at = now()`, [day, key, JSON.stringify(m)]);
    out[key] = m;
  }
  return out;
}

export async function weeklySummary(db: Queryable, endDay: string): Promise<{ days: Array<{ day: string; metrics: DayMetrics }>; totals: Partial<DayMetrics> }> {
  const r = await db.query(`SELECT day::text AS day, metrics FROM daily_metrics WHERE sector_key = 'all' AND day > $1::date - 7 AND day <= $1::date ORDER BY day`, [endDay]);
  const totals: Record<string, number> = {};
  for (const row of r.rows) for (const [k, v] of Object.entries(row.metrics as DayMetrics)) if (!['approvals_pending', 'mrr_cents', 'active_subscriptions'].includes(k)) totals[k] = (totals[k] ?? 0) + Number(v);
  return { days: r.rows, totals };
}
