import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeScore } from '../src/scoring/score.js';
import { recommendService } from '../src/catalog/services.js';
import { loadSectorFiles } from '../src/sectors/loader.js';
import { loadServiceCatalog } from '../src/catalog/services.js';
import type { SectorConfig } from '../src/sectors/types.js';

let sectors: Record<string, SectorConfig>;
let services: any[];
beforeAll(async () => { sectors = Object.fromEntries((await loadSectorFiles()).map((s) => [s.key, s])); services = (await loadServiceCatalog()).services; });
afterAll(() => undefined);

describe('sektörel puanlama', () => {
  it('güzellikte online randevu yokluğu yüksek ağırlıklıdır', () => {
    const r = computeScore(sectors.beauty, [{ kind: 'observation', field: 'has_online_booking', value: false, confidence: 1, source_key: 'website' }]);
    expect(r.hits).toContain('no_online_booking');
    expect(r.breakdown.no_online_booking.weight).toBe(20);
    expect(r.score).toBeGreaterThan(0);
  });
  it('çıkarım yalnız inference_ok sinyalleri besler ve güvenle ağırlıklanır', () => {
    const onlyInf = computeScore(sectors.education, [
      { kind: 'inference', field: 'has_online_booking', value: false, confidence: 0.9, source_key: 'ai_inference' },
      { kind: 'inference', field: 'multi_branch', value: true, confidence: 0.5, source_key: 'ai_inference' }
    ]);
    expect(onlyInf.breakdown.no_online_booking.hit).toBe(false);
    expect(onlyInf.breakdown.no_online_booking.basis).toBe('none');
    expect(onlyInf.breakdown.multi_branch.hit).toBe(true);
    expect(onlyInf.breakdown.multi_branch.basis).toBe('inference');
    const total = Object.values(sectors.education.signals).reduce((a, s) => a + s.weight, 0);
    expect(onlyInf.score).toBe(Math.round((10 * 0.5 / total) * 100));
  });
  it('gözlem çıkarımı ezer', () => {
    const r = computeScore(sectors.education, [
      { kind: 'observation', field: 'multi_branch', value: false, confidence: 1, source_key: 'manual' },
      { kind: 'inference', field: 'multi_branch', value: true, confidence: 0.9, source_key: 'ai_inference' }
    ]);
    expect(r.breakdown.multi_branch.hit).toBe(false);
    expect(r.breakdown.multi_branch.basis).toBe('observation');
  });
  it('tüm sinyaller tutunca 100, hiçbiri tutmazsa 0', () => {
    for (const s of Object.values(sectors)) {
      const all = Object.values(s.signals).map((sig) => ({ kind: 'observation' as const, field: sig.evidence_field, value: sig.expect, confidence: 1, source_key: 'x' }));
      expect(computeScore(s, all).score).toBe(100);
      expect(computeScore(s, []).score).toBe(0);
      expect(s.qualification_threshold).toBeGreaterThan(0);
    }
  });
  it('hizmet önerisi sinyallere göre değişir', () => {
    const noBooking = recommendService(sectors.beauty, services, new Set(['no_online_booking']));
    expect(noBooking?.service_key).toBe('appointment_lead_management');
    const noWa = recommendService(sectors.education, services, new Set(['no_whatsapp_link', 'no_whatsapp_link']));
    expect(['whatsapp_ai_assistant', 'appointment_lead_management']).toContain(noWa?.service_key);
  });
});
