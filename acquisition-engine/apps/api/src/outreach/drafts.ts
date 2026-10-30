import type { Queryable } from '../db/pool.js';
import type { Config } from '../config.js';
import type { AiProvider, DraftInput } from '../ai/types.js';
import type { SectorConfig } from '../sectors/types.js';
import { listServices, recommendService } from '../catalog/services.js';
import { validateDraft } from './validate.js';
import { decidePolicy, isOutreachPaused, isSuppressed, type Channel } from './policy.js';
import { renderTemplateDraft } from './templates.js';
import { createTask } from '../sales/tasks.js';
import { audit } from '../audit.js';

export interface PrepareResult { draft_id: string | null; status: string; policy: ReturnType<typeof decidePolicy> | null; validation: ReturnType<typeof validateDraft> | null; skipped?: string }

/**
 * Nitelikli bir işletme için kişiselleştirilmiş taslak hazırlar, doğrular, politika kararı verir
 * ve onay kuyruğuna ekler. Hiçbir koşulda gönderim yapmaz.
 */
export async function prepareDraftForBusiness(db: Queryable, cfg: Config, ai: AiProvider, sector: SectorConfig, businessId: string, opts: { channel?: Channel; senderName?: string; sequence?: number } = {}): Promise<PrepareResult> {
  const b = (await db.query('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0];
  if (!b) return { draft_id: null, status: 'skipped', policy: null, validation: null, skipped: 'İşletme yok' };
  if (!['qualified', 'contacted', 'replied'].includes(b.status)) return { draft_id: null, status: 'skipped', policy: null, validation: null, skipped: `Durum uygun değil: ${b.status}` };

  const contact = (await db.query('SELECT * FROM contacts WHERE business_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1', [businessId])).rows[0] ?? null;
  const email = contact?.email_normalized ?? b.email_public ?? null;
  const channel: Channel = opts.channel ?? (email ? 'email' : b.instagram_handle ? 'instagram' : b.phone_e164 ? 'whatsapp' : 'phone');
  // İdempotency: aynı işletme+kanal için ETKİN bir taslak varsa yenisi üretilmez.
  // 'dry_run' (K3) ve 'cancelled' taslaklar etkin sayılmaz; yeni taslak bir sonraki sıra numarasıyla açılır.
  const existing = (await db.query(
    `SELECT id, status FROM message_drafts WHERE business_id = $1 AND channel = $2 AND status NOT IN ('dry_run','cancelled') ORDER BY created_at DESC LIMIT 1`,
    [businessId, channel]
  )).rows[0];
  if (existing && opts.sequence === undefined) return { draft_id: existing.id, status: existing.status, policy: null, validation: null, skipped: 'Zaten var (idempotent)' };
  const seq = opts.sequence ?? Number((await db.query('SELECT COUNT(*)::int AS n FROM message_drafts WHERE business_id = $1 AND channel = $2', [businessId, channel])).rows[0].n) + 1;
  const idem = `${businessId}:${channel}:${seq}`;
  const byKey = (await db.query('SELECT id, status FROM message_drafts WHERE idempotency_key = $1', [idem])).rows[0];
  if (byKey) return { draft_id: byKey.id, status: byKey.status, policy: null, validation: null, skipped: 'Zaten var (idempotent)' };

  // Kanıt: yalnız doğrulanmış gözlemler taslağa girer (çıkarımlar girmez)
  const evidence = await db.query(`SELECT id, field, value, source_key FROM research_evidence WHERE business_id = $1 AND kind = 'observation' ORDER BY captured_at`, [businessId]);
  const labels = Object.fromEntries(Object.values(sector.signals).map((s) => [s.evidence_field, s.label]));
  const facts = evidence.rows.filter((e) => e.field in labels).map((e) => ({ id: e.id as string, field: e.field as string, value: e.value, label: labels[e.field] }));

  const services = await listServices(db);
  const hits = new Set<string>(Object.entries(b.score_breakdown ?? {}).filter(([, v]: any) => v?.hit).map(([k]) => k));
  const rec = recommendService(sector, services, hits);
  const service = services.find((s) => s.key === rec?.service_key) ?? services[0];
  if (!service) return { draft_id: null, status: 'skipped', policy: null, validation: null, skipped: 'Hizmet kataloğu boş' };
  await db.query('UPDATE businesses SET recommended_service_key = $2 WHERE id = $1', [businessId, service.key]);

  const input: DraftInput = {
    sectorKey: sector.key, sectorName: sector.name, channel,
    business: { name: b.name, city: b.city },
    serviceName: service.name,
    angle: sector.message_angles[service.key] ?? service.description,
    facts,
    restrictions: [...(sector.compliance.ai_assistant_restrictions ?? []), 'no_pricing', 'no_fabrication'],
    senderName: opts.senderName ?? cfg.EMAIL_FROM_NAME
  };
  let draft = await ai.draft(input).catch(() => renderTemplateDraft(input));
  let generator = ai.key === 'mock' ? 'template' : 'llm';
  let validation = validateDraft(draft, input);
  if (!validation.ok) {
    // AI taslağı geçemedi → güvenli şablona düş
    draft = renderTemplateDraft(input);
    generator = 'template_fallback';
    validation = { ...validateDraft(draft, input), warnings: [...validation.errors.map((e) => 'AI taslağı reddedildi: ' + e)] };
  }

  const perm = (await db.query(`SELECT status FROM channel_permissions WHERE business_id = $1 AND channel = $2 ORDER BY contact_id NULLS LAST LIMIT 1`, [businessId, channel])).rows[0]?.status ?? 'unknown';
  const toAddress = channel === 'email' ? email : channel === 'whatsapp' ? (contact?.phone_e164 ?? b.phone_e164) : null;
  const policy = decidePolicy({
    cfg, channel, sectorKey: sector.key, business: b, toAddress, permissionStatus: perm,
    suppressed: await isSuppressed(db, b, email), outreachPaused: (await isOutreachPaused(db)).paused
  });

  const status = policy.mode === 'blocked' ? 'blocked' : validation.ok ? 'pending_approval' : 'blocked';
  const ins = await db.query(
    `INSERT INTO message_drafts(business_id, contact_id, channel, service_key, subject, body, facts_used, generator, validation, policy_decision, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [businessId, contact?.id ?? null, channel, service.key, draft.subject, draft.body, JSON.stringify(draft.facts_used), generator, JSON.stringify(validation), JSON.stringify(policy), status, idem]
  );
  const draftId = ins.rows[0].id as string;
  await audit(db, { actorType: 'system', action: 'draft_prepared', entityType: 'message_draft', entityId: draftId, after: { channel, status, policy: policy.mode } });
  return { draft_id: draftId, status, policy, validation };
}
