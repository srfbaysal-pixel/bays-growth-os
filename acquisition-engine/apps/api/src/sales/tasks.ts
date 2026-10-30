import type { Queryable } from '../db/pool.js';

export interface NewTask {
  business_id?: string | null; deal_id?: string | null; draft_id?: string | null;
  kind: 'manual_outreach' | 'follow_up' | 'call' | 'meeting' | 'compliance_check' | 'review_reply' | 'other';
  channel?: string | null; title: string; description?: string; due_at?: Date | null; assigned_to?: string | null; dedup_key?: string | null;
}

export async function createTask(db: Queryable, t: NewTask): Promise<string | null> {
  const r = await db.query(
    `INSERT INTO tasks(business_id, deal_id, draft_id, kind, channel, title, description, due_at, assigned_to, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [t.business_id ?? null, t.deal_id ?? null, t.draft_id ?? null, t.kind, t.channel ?? null, t.title, t.description ?? '', t.due_at ?? null, t.assigned_to ?? null, t.dedup_key ?? null]
  );
  return r.rows[0]?.id ?? null;
}

export async function completeTask(db: Queryable, id: string, status: 'done' | 'cancelled' = 'done'): Promise<void> {
  await db.query(`UPDATE tasks SET status = $2, completed_at = now() WHERE id = $1`, [id, status]);
}
