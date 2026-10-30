import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import { emailHealthSnapshot } from '../outreach/killswitch.js';
import { isOutreachPaused } from '../outreach/policy.js';

export async function heartbeat(db: Queryable, workflowKey: string, runId: string, status: 'running' | 'succeeded' | 'failed' | 'partial', stats?: unknown, error?: string | null): Promise<void> {
  await db.query(
    `INSERT INTO workflow_runs(workflow_key, run_id, status, stats, error, finished_at)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $3 = 'running' THEN NULL ELSE now() END)
     ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, stats = COALESCE(EXCLUDED.stats, workflow_runs.stats), error = EXCLUDED.error, finished_at = EXCLUDED.finished_at`,
    [workflowKey, runId, status, JSON.stringify(stats ?? {}), error ?? null]
  );
}

export function integrationStatuses(cfg: Config): Array<{ key: string; status: string; detail: string }> {
  const s = (key: string, status: string, detail: string) => ({ key, status, detail });
  return [
    s('email', cfg.EMAIL_PROVIDER === 'mock' ? 'mock' : cfg.DRY_RUN ? 'configured' : 'live', `sağlayıcı=${cfg.EMAIL_PROVIDER}, DRY_RUN=${cfg.DRY_RUN}, LIVE=${cfg.LIVE_OUTREACH_ENABLED}`),
    s('discovery', cfg.DISCOVERY_PROVIDER === 'mock' ? 'mock' : cfg.GOOGLE_PLACES_API_KEY ? 'configured' : 'disconnected', `sağlayıcı=${cfg.DISCOVERY_PROVIDER}`),
    s('ai', cfg.AI_PROVIDER === 'mock' ? 'mock' : cfg.ANTHROPIC_API_KEY ? 'configured' : 'disconnected', `sağlayıcı=${cfg.AI_PROVIDER}`),
    s('whatsapp', cfg.WHATSAPP_ENABLED && cfg.WHATSAPP_ACCESS_TOKEN ? 'configured' : 'disconnected', 'yalnız onaylı şablon + opt-in; varsayılan kapalı'),
    s('instagram_dm', 'disconnected', 'otomatik soğuk DM yapılmaz; manuel görev'),
    s('linkedin', 'disconnected', 'otomatik soğuk mesaj yapılmaz; manuel görev'),
    s('compliance', cfg.COMPLIANCE_IYS_VERIFIED && cfg.COMPLIANCE_KVKK_VERIFIED ? 'verified' : 'disconnected', `İYS=${cfg.COMPLIANCE_IYS_VERIFIED} KVKK=${cfg.COMPLIANCE_KVKK_VERIFIED} Klinik=${cfg.COMPLIANCE_CLINIC_ADVERTISING_VERIFIED}`)
  ];
}

export async function systemHealth(db: Queryable, cfg: Config) {
  const runs = (await db.query(`SELECT DISTINCT ON (workflow_key) workflow_key, run_id, status, started_at, finished_at, stats, error FROM workflow_runs ORDER BY workflow_key, started_at DESC`)).rows;
  const queue = (await db.query(`SELECT status, COUNT(*)::int AS n FROM send_jobs GROUP BY status`)).rows;
  const approvals = Number((await db.query(`SELECT COUNT(*) n FROM message_drafts WHERE status = 'pending_approval'`)).rows[0].n);
  const openTasks = Number((await db.query(`SELECT COUNT(*) n FROM tasks WHERE status = 'open'`)).rows[0].n);
  const unmatched = Number((await db.query(`SELECT COUNT(*) n FROM inbound_messages WHERE matched_business_id IS NULL AND received_at > now() - interval '7 days'`)).rows[0].n);
  const recentErrors = (await db.query(`SELECT e.occurred_at, e.detail, j.to_address FROM send_events e JOIN send_jobs j ON j.id = e.send_job_id WHERE e.event IN ('error','bounce','complaint','reject') ORDER BY e.occurred_at DESC LIMIT 20`)).rows;
  const paused = await isOutreachPaused(db);
  const email = await emailHealthSnapshot(db, cfg.EMAIL_PROVIDER);
  const dbOk = (await db.query('SELECT 1 AS ok')).rows[0]?.ok === 1;
  return {
    db_ok: dbOk,
    mode: { dry_run: cfg.DRY_RUN, live_outreach_enabled: cfg.LIVE_OUTREACH_ENABLED, test_recipients: cfg.TEST_RECIPIENTS.length },
    outreach_paused: paused,
    email: { ...email, daily_quota: cfg.EMAIL_DAILY_QUOTA, hourly_quota: cfg.EMAIL_HOURLY_QUOTA, provider: cfg.EMAIL_PROVIDER },
    workflows: runs,
    queue: Object.fromEntries(queue.map((r) => [r.status, r.n])),
    approvals_pending: approvals,
    open_tasks: openTasks,
    unmatched_inbound_7d: unmatched,
    recent_errors: recentErrors,
    integrations: integrationStatuses(cfg)
  };
}
