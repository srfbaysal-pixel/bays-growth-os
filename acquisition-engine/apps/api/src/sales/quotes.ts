import type { Queryable } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';

export async function createQuote(db: Queryable, input: { deal_id: string; plan_id?: string | null; setup_fee_cents?: number; monthly_fee_cents?: number; discount_pct?: number; valid_until?: string | null; notes?: string | null }): Promise<string> {
  const deal = (await db.query('SELECT id, business_id, service_key FROM deals WHERE id = $1', [input.deal_id])).rows[0];
  if (!deal) throw notFound('Fırsat yok');
  let setup = input.setup_fee_cents ?? 0, monthly = input.monthly_fee_cents ?? 0, service = deal.service_key;
  if (input.plan_id) {
    const p = (await db.query('SELECT * FROM price_plans WHERE id = $1 AND is_active', [input.plan_id])).rows[0];
    if (!p) throw badRequest('Fiyat planı yok/pasif');
    if (Number(p.setup_fee_cents) === 0 && Number(p.monthly_fee_cents) === 0 && input.setup_fee_cents == null && input.monthly_fee_cents == null) throw badRequest('Plan fiyatı yer tutucu (0). Önce gerçek fiyatı girin.');
    setup = input.setup_fee_cents ?? Number(p.setup_fee_cents); monthly = input.monthly_fee_cents ?? Number(p.monthly_fee_cents); service = p.service_key;
  }
  const r = await db.query(
    `INSERT INTO quotes(deal_id, business_id, plan_id, service_key, setup_fee_cents, monthly_fee_cents, discount_pct, valid_until, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [deal.id, deal.business_id, input.plan_id ?? null, service, setup, monthly, input.discount_pct ?? 0, input.valid_until ?? null, input.notes ?? null]
  );
  await db.query(`UPDATE deals SET stage = 'proposal', value_cents = $2 WHERE id = $1 AND stage NOT IN ('won','lost','negotiation')`, [deal.id, setup + monthly * 12]);
  return r.rows[0].id;
}

export async function setQuoteStatus(db: Queryable, id: string, status: 'sent' | 'accepted' | 'rejected' | 'expired'): Promise<void> {
  const q = (await db.query('SELECT * FROM quotes WHERE id = $1', [id])).rows[0];
  if (!q) throw notFound('Teklif yok');
  await db.query(`UPDATE quotes SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END, decided_at = CASE WHEN $2 IN ('accepted','rejected') THEN now() ELSE decided_at END WHERE id = $1`, [id, status]);
  if (status === 'accepted') {
    await db.query(
      `INSERT INTO subscriptions(business_id, quote_id, service_key, plan_id, monthly_fee_cents, setup_fee_cents, currency, status, next_billing_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active', CURRENT_DATE + 30)`,
      [q.business_id, q.id, q.service_key, q.plan_id, Math.round(Number(q.monthly_fee_cents) * (1 - Number(q.discount_pct) / 100)), q.setup_fee_cents, q.currency]
    );
    await db.query(`UPDATE deals SET stage = 'won', closed_at = now() WHERE id = $1`, [q.deal_id]);
    await db.query(`UPDATE businesses SET status = 'customer' WHERE id = $1`, [q.business_id]);
  }
}
