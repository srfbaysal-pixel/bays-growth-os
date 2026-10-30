import type pg from 'pg';
import type { AiProvider } from '../ai/types.js';
import { processInbound, type InboundEmail, type InboundResult } from '../inbound/process.js';
import { storeDayMetrics, weeklySummary } from '../metrics/daily.js';
import { heartbeat } from '../health/status.js';

/** WF3-A — Gelen yanıt kümesi (IMAP/webhook) işleme. */
export async function runWf3Inbound(pool: pg.Pool, ai: AiProvider, params: { runId: string; messages: InboundEmail[] }): Promise<{ results: InboundResult[]; errors: string[] }> {
  const results: InboundResult[] = [];
  const errors: string[] = [];
  await heartbeat(pool, 'wf3_replies', params.runId, 'running');
  for (const m of params.messages) {
    try { results.push(await processInbound(pool, ai, m)); }
    catch (e) { errors.push(`${m.from}: ${(e as Error).message}`); }
  }
  await heartbeat(pool, 'wf3_replies', params.runId, errors.length ? 'partial' : 'succeeded', { processed: results.length, matched: results.filter((r) => r.matched).length, errors: errors.length });
  return { results, errors };
}

/** WF3-B — Günlük metrik hesaplama ve (haftalık) özet. */
export async function runWf3Metrics(pool: pg.Pool, params: { runId: string; day?: string; weekly?: boolean }) {
  const day = params.day ?? new Date().toISOString().slice(0, 10);
  await heartbeat(pool, 'wf3_metrics', params.runId, 'running');
  const daily = await storeDayMetrics(pool, day);
  const weekly = params.weekly ? await weeklySummary(pool, day) : null;
  await heartbeat(pool, 'wf3_metrics', params.runId, 'succeeded', { day, sectors: Object.keys(daily).length });
  return { day, daily, weekly };
}
