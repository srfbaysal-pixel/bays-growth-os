import type { Queryable } from './db/pool.js';

export interface AuditEntry {
  actorType: 'user' | 'system' | 'n8n';
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(actor_type, actor_id, action, entity_type, entity_id, before_data, after_data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.actorType, e.actorId ?? null, e.action, e.entityType ?? null, e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.ip ?? null]
  );
}
