import { describe, it, expect } from 'vitest';
import { decidePolicy } from '../src/outreach/policy.js';
import { testConfig } from '../src/config.js';

const biz = { id: 'b1', status: 'qualified' };
const base = (over: any = {}) => ({ cfg: testConfig(), channel: 'email' as const, sectorKey: 'beauty', business: biz, toAddress: 'x@firma.example', permissionStatus: 'unknown', suppressed: false, outreachPaused: false, ...over });

describe('kanal politikası', () => {
  it('Instagram ve LinkedIn asla otomatik gönderilmez', () => {
    expect(decidePolicy(base({ channel: 'instagram' })).mode).toBe('manual_task');
    expect(decidePolicy(base({ channel: 'linkedin' })).mode).toBe('manual_task');
  });
  it('engelleme listesi her şeyi durdurur', () => {
    expect(decidePolicy(base({ suppressed: true })).mode).toBe('blocked');
    expect(decidePolicy(base({ permissionStatus: 'opt_out' })).mode).toBe('blocked');
    expect(decidePolicy(base({ business: { id: 'b', status: 'suppressed' } })).mode).toBe('blocked');
  });
  it('test modunda yalnız izinli test alıcısına otomatik gönderim', () => {
    const d1 = decidePolicy(base());
    expect(d1.mode).toBe('manual_task');
    expect(d1.test_mode).toBe(true);
    const d2 = decidePolicy(base({ toAddress: 'test@example.com' }));
    expect(d2.mode).toBe('auto_send');
    expect(d2.test_mode).toBe(true);
  });
  it('canlı modda uyumluluk doğrulanmadan otomatik gönderim yok', () => {
    const live = testConfig({ DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any });
    expect(live.LIVE_OUTREACH_ENABLED).toBe(true);
    const d = decidePolicy(base({ cfg: live }));
    expect(d.mode).toBe('manual_task');
    expect(d.reasons.join(' ')).toMatch(/İYS|KVKK/);
    const compliant = testConfig({ DRY_RUN: false as any, LIVE_OUTREACH_ENABLED: true as any, COMPLIANCE_IYS_VERIFIED: true as any, COMPLIANCE_KVKK_VERIFIED: true as any });
    expect(decidePolicy(base({ cfg: compliant })).mode).toBe('auto_send');
    expect(decidePolicy(base({ cfg: compliant, sectorKey: 'clinic' })).mode).toBe('manual_task');
  });
  it('DRY_RUN açıkken LIVE bayrağı etkisizdir', () => {
    const c = testConfig({ DRY_RUN: true as any, LIVE_OUTREACH_ENABLED: true as any });
    expect(c.LIVE_OUTREACH_ENABLED).toBe(false);
  });
  it('WhatsApp için opt-in ve etkinleştirme zorunlu', () => {
    const d = decidePolicy(base({ channel: 'whatsapp', toAddress: '+905551112233' }));
    expect(d.mode).toBe('manual_task');
    expect(d.reasons.join(' ')).toMatch(/opt-in/);
  });
  it('kill-switch gönderimi engeller', () => {
    expect(decidePolicy(base({ outreachPaused: true, toAddress: 'test@example.com' })).mode).toBe('blocked');
  });
});
