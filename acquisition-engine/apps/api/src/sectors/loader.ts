import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import type { SectorConfig } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SECTORS_DIR = path.resolve(here, '../../../../config/sectors');

const SignalSchema = z.object({
  weight: z.number().min(0).max(100),
  label: z.string(),
  evidence_field: z.string(),
  expect: z.union([z.boolean(), z.string(), z.number()]),
  inference_ok: z.boolean().optional()
});
export const SectorSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  description: z.string().optional(),
  discovery: z.object({
    queries: z.array(z.string()).min(1),
    google_place_types: z.array(z.string()).optional(),
    exclude_name_patterns: z.array(z.string()).optional()
  }),
  signals: z.record(z.string(), SignalSchema),
  qualification_threshold: z.number().min(0).max(100),
  service_preference: z.array(z.string()).min(1),
  message_angles: z.record(z.string(), z.string()),
  compliance: z.object({
    requires_legal_review_for_campaign: z.boolean(),
    collect_health_data: z.boolean(),
    ai_assistant_restrictions: z.array(z.string()).optional(),
    special_notes: z.string().optional()
  })
});

export async function loadSectorFiles(dir = SECTORS_DIR): Promise<SectorConfig[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: SectorConfig[] = [];
  for (const f of files) {
    const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    const parsed = SectorSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Sektör dosyası geçersiz (${f}): ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
    out.push(parsed.data as SectorConfig);
  }
  return out;
}

export async function upsertSectors(db: Queryable, sectors: SectorConfig[]): Promise<void> {
  for (const s of sectors) {
    await db.query(
      `INSERT INTO sectors(key, name, config, is_active) VALUES ($1,$2,$3,true)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config, updated_at = now()`,
      [s.key, s.name, JSON.stringify(s)]
    );
  }
}

export async function getSector(db: Queryable, key: string): Promise<SectorConfig | null> {
  const r = await db.query('SELECT config FROM sectors WHERE key = $1 AND is_active', [key]);
  return (r.rows[0]?.config as SectorConfig) ?? null;
}

export async function listSectors(db: Queryable): Promise<SectorConfig[]> {
  const r = await db.query('SELECT config FROM sectors WHERE is_active ORDER BY key');
  return r.rows.map((x) => x.config as SectorConfig);
}
