import type pg from 'pg';
import type { Config } from '../config.js';
import type { AiProvider } from '../ai/types.js';
import type { EmailProvider } from '../email/types.js';
import { getSector } from '../sectors/loader.js';
import { prepareDraftForBusiness } from '../outreach/drafts.js';
import { processSendQueue, type SenderStats } from '../outreach/sender.js';
import { heartbeat } from '../health/status.js';

export interface Wf2PrepareStats { candidates: number; prepared: number; pending_approval: number; blocked: number; skipped: number; errors: string[] }

/** WF2-A — Nitelikli lead'ler için taslak hazırla ve onay kuyruğuna koy (gönderim yok). */
export async function runWf2Prepare(pool: pg.Pool, cfg: Config, ai: AiProvider, params: { runId: string; limit?: number; sectorKey?: string | null }): Promise<Wf2PrepareStats> {
  const stats: Wf2PrepareStats = { candidates: 0, prepared: 0, pending_approval: 0, blocked: 0, skipped: 0, errors: [] };
  await heartbeat(pool, 'wf2_outreach', params.runId, 'running', stats);
  try {
    const rows = (await pool.query(
      `SELECT b.id, b.sector_key FROM businesses b
        WHERE b.status = 'qualified' AND ($1::text IS NULL OR b.sector_key = $1)
          AND NOT EXISTS (SELECT 1 FROM message_drafts d WHERE d.business_id = b.id AND d.status NOT IN ('dry_run','cancelled'))
        ORDER BY b.lead_score DESC, b.created_at LIMIT $2`,
      [params.sectorKey ?? null, params.limit ?? 20]
    )).rows;
    stats.candidates = rows.length;
    for (const r of rows) {
      try {
        const sector = await getSector(pool, r.sector_key);
        if (!sector) { stats.skipped++; continue; }
        const res = await prepareDraftForBusiness(pool, cfg, ai, sector, r.id);
        if (res.skipped) stats.skipped++;
        else { stats.prepared++; if (res.status === 'pending_approval') stats.pending_approval++; else stats.blocked++; }
      } catch (e) { stats.errors.push(`${r.id}: ${(e as Error).message}`); }
    }
    await heartbeat(pool, 'wf2_outreach', params.runId, stats.errors.length ? 'partial' : 'succeeded', stats);
  } catch (e) {
    stats.errors.push((e as Error).message);
    await heartbeat(pool, 'wf2_outreach', params.runId, 'failed', stats, (e as Error).message);
  }
  return stats;
}

/** WF2-B — Onaylanmış ve kuyruğa alınmış işleri gönder (politika + kota + kill-switch korumalı). */
export async function runWf2Send(pool: pg.Pool, cfg: Config, provider: EmailProvider, params: { runId: string; limit?: number }): Promise<SenderStats> {
  await heartbeat(pool, 'wf2_sender', params.runId, 'running');
  try {
    const s = await processSendQueue(pool, cfg, provider, params.limit ?? 10);
    await heartbeat(pool, 'wf2_sender', params.runId, s.failed ? 'partial' : 'succeeded', s);
    return s;
  } catch (e) {
    await heartbeat(pool, 'wf2_sender', params.runId, 'failed', {}, (e as Error).message);
    throw e;
  }
}
