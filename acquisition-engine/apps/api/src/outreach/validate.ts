import type { DraftOutput, DraftInput } from '../ai/types.js';

export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[] }

const PLACEHOLDER = /(\{\{|\}\}|\[isim\]|\[şirket\]|\[company\]|\[name\]|<isim>|lorem ipsum|XXX)/i;
const FORBIDDEN_CLAIMS = [/garanti\s*(ediyoruz|ederiz)/i, /%\s*\d{2,3}\s*(artış|büyüme)/i, /kesinlikle\s*(artar|kazanırsınız)/i, /ücretsiz\s*deneme/i, /\b(teşhis|tedavi\s*eder|iyileştirir)\b/i];
const PRICE = /(\d[\d.,]*\s*(₺|tl|try|usd|\$|€))/i;
const HEALTH_DATA = /(hasta\s*kay[ıi]tlar[ıi]|hastal[ıi]k|tan[ıi]\s*bilgisi|reçete)/i;

/** Yanlış kişiselleştirme ve riskli içerik kontrolü (deterministik). */
export function validateDraft(draft: DraftOutput, input: DraftInput, opts: { maxWords?: number } = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = `${draft.subject ?? ''}\n${draft.body}`;
  if (!draft.body.trim()) errors.push('Gövde boş');
  if (PLACEHOLDER.test(text)) errors.push('Doldurulmamış yer tutucu var');
  if (!draft.body.includes(input.business.name)) errors.push('İşletme adı gövdede tam olarak geçmiyor');
  const validIds = new Set(input.facts.map((f) => f.id));
  for (const id of draft.facts_used) if (!validIds.has(id)) errors.push(`Bilinmeyen kanıt kimliği: ${id}`);
  for (const re of FORBIDDEN_CLAIMS) if (re.test(text)) errors.push(`Yasak iddia: ${re.source}`);
  if (PRICE.test(text)) errors.push('Taslakta fiyat geçiyor (fiyat yalnız teklif aşamasında verilir)');
  if (input.sectorKey === 'clinic' && HEALTH_DATA.test(text)) errors.push('Klinik: sağlık verisi ifadesi');
  const words = draft.body.trim().split(/\s+/).length;
  if (words > (opts.maxWords ?? 160)) errors.push(`Çok uzun (${words} kelime)`);
  if (!/hayır|reddetmek|rahatsız etmeyiz|iletişim listemizden/i.test(draft.body)) errors.push('Ret/çıkış ifadesi yok');
  if (input.channel === 'email' && !draft.subject) errors.push('E-posta için konu gerekli');
  // Başka işletme adı sızıntısı (basit): facts dışı büyük harfli ticari ek
  if (/\b(Ltd|A\.Ş\.|Şti)\b/.test(draft.body) && !/\b(Ltd|A\.Ş\.|Şti)\b/.test(input.business.name)) warnings.push('Gövdede başka bir ticari unvan olabilir');
  if (draft.facts_used.length === 0) warnings.push('Hiç doğrulanmış kanıt kullanılmadı (genel mesaj)');
  return { ok: errors.length === 0, errors, warnings };
}
