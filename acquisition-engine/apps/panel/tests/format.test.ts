import { describe, it, expect } from 'vitest';
import { fmtMoney, tr, SECTOR_NAMES } from '../lib/api';

describe('panel yardımcıları', () => {
  it('para birimi TL biçimlendirilir', () => {
    expect(fmtMoney(450000)).toMatch(/4\.500/);
    expect(fmtMoney(null)).toMatch(/0/);
  });
  it('durum çevirileri', () => {
    expect(tr('pending_approval')).toBe('Onay bekliyor');
    expect(tr('bilinmeyen_durum')).toBe('bilinmeyen_durum');
    expect(tr(null)).toBe('—');
    expect(Object.keys(SECTOR_NAMES)).toEqual(['education', 'beauty', 'clinic']);
  });
});
