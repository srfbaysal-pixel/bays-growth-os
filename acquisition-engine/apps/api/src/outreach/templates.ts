import type { DraftInput, DraftOutput } from '../ai/types.js';

/**
 * Şablon tabanlı taslak: yalnız doğrulanmış gerçeklerden cümle kurar.
 * AI kapalıyken veya AI çıktısı doğrulamadan geçemediğinde kullanılır.
 */
export function renderTemplateDraft(input: DraftInput): DraftOutput {
  const factById = new Map(input.facts.map((f) => [f.id, f]));
  const used: string[] = [];
  const observations: string[] = [];
  for (const f of input.facts) {
    if (f.field === 'has_online_booking' && f.value === false) { observations.push('web sitenizde online randevu/kayıt adımı görmedik'); used.push(f.id); }
    else if (f.field === 'has_whatsapp_link' && f.value === false) { observations.push('WhatsApp üzerinden hızlı iletişim bağlantısı fark etmedik'); used.push(f.id); }
    else if (f.field === 'review_count_gte_20' && f.value === true) { observations.push('Google yorumlarınız yoğun bir müşteri ilgisi gösteriyor'); used.push(f.id); }
    if (observations.length >= 2) break;
  }
  const city = input.business.city ? ` (${input.business.city})` : '';
  const obsLine = observations.length ? `İncelediğimizde ${observations.join(' ve ')}.` : 'Sektörünüzdeki işletmelerle çalışıyoruz.';
  const isClinic = input.sectorKey === 'clinic';
  const bodyLines = [
    `Merhaba ${input.business.name} ekibi${city},`,
    '',
    `Ben ${input.senderName}, BaysSystems'den yazıyorum. ${obsLine}`,
    `${input.serviceName} ile ${input.angle} konusunda destek olabiliriz.${isClinic ? ' Sistemlerimiz tıbbi tavsiye vermez ve sağlık verisi toplamaz.' : ''}`,
    '',
    'Uygunsa 15 dakikalık kısa bir görüşmede nasıl çalıştığını gösterebilirim.',
    'İlgilenmiyorsanız bu mesaja "hayır" yazmanız yeterli; sizi bir daha rahatsız etmeyiz.',
    '',
    `${input.senderName}`,
    'BaysSystems'
  ];
  void factById;
  return {
    subject: input.channel === 'email' ? `${input.business.name} için ${input.serviceName.toLocaleLowerCase('tr-TR')}` : null,
    body: bodyLines.join('\n'),
    facts_used: used
  };
}
