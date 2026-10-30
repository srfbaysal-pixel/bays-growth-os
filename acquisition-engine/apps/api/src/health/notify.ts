import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import { audit } from '../audit.js';
import { createTask } from '../sales/tasks.js';
import { signRequest } from '../lib/crypto.js';
import { log } from '../lib/logger.js';

export interface AdminAlert { kind: 'kill_switch' | 'workflow_failed' | 'other'; title: string; body: string; detail?: unknown }

/**
 * Ö8 — Yönetici bildirimi. Üç katman, hiçbiri hata fırlatmaz:
 *  1) panelde görünen görev (tasks, kind=other) — her zaman,
 *  2) audit_log kaydı — her zaman,
 *  3) ALERT_WEBHOOK_URL varsa imzalı POST (n8n webhook'u → e-posta/WhatsApp/Telegram; kullanıcı bağlar).
 * E-posta ile bildirim bilinçli olarak yapılmaz: kill-switch çoğu zaman e-posta altyapısı arızasında tetiklenir.
 */
export async function notifyAdmin(db: Queryable, cfg: Config, alert: AdminAlert, fetchFn: typeof fetch = fetch): Promise<{ task: boolean; webhook: 'sent' | 'skipped' | 'failed' }> {
  const day = new Date().toISOString().slice(0, 10);
  let task = false;
  try {
    const id = await createTask(db, { kind: 'other', channel: 'system', title: `[UYARI] ${alert.title}`, description: alert.body, due_at: new Date(), dedup_key: `alert:${alert.kind}:${day}:${alert.title}` });
    task = Boolean(id);
  } catch (e) { log.error('alert task yazılamadı', { error: (e as Error).message }); }
  try { await audit(db, { actorType: 'system', action: `alert_${alert.kind}`, after: { title: alert.title, body: alert.body, detail: alert.detail ?? null } }); } catch { /* audit opsiyonel */ }
  if (!cfg.ALERT_WEBHOOK_URL) return { task, webhook: 'skipped' };
  try {
    const body = JSON.stringify({ kind: alert.kind, title: alert.title, body: alert.body, detail: alert.detail ?? null, at: new Date().toISOString(), to: cfg.ALERT_EMAIL ?? null });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetchFn(cfg.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bays-timestamp': ts, 'x-bays-signature': signRequest(cfg.N8N_SHARED_SECRET, ts, body) }, body, signal: AbortSignal.timeout(8000) });
    if (!res.ok) { log.warn('alert webhook başarısız', { status: res.status }); return { task, webhook: 'failed' }; }
    return { task, webhook: 'sent' };
  } catch (e) { log.warn('alert webhook hatası', { error: (e as Error).message }); return { task, webhook: 'failed' }; }
}
