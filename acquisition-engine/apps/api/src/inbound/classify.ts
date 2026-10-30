import type { ReplyClass } from '../ai/types.js';

const RULES: Array<{ cls: ReplyClass; re: RegExp; conf: number }> = [
  { cls: 'bounce', re: /(mail delivery (failed|subsystem)|undeliverable|delivery status notification|address not found|user unknown|mailbox (full|unavailable)|teslim edilemedi)/i, conf: 0.98 },
  { cls: 'out_of_office', re: /(out of office|ofis dışında|izindeyim|yıllık izin|otomatik yanıt|auto-?reply|automatic reply)/i, conf: 0.95 },
  { cls: 'rejected', re: /(^|\s)(hayır|hayir|istemiyorum|ilgilenmiyoruz|ilgilenmiyorum|listeden çıkar|çıkarın|bir daha (yazmayın|göndermeyin)|unsubscribe|spam|rahatsız etmeyin|teşekkürler,? (ihtiyacımız yok|gerek yok))/i, conf: 0.92 },
  { cls: 'meeting_request', re: /(görüşme|toplantı|arayın|arayabilir misiniz|ne zaman müsait|randevu alalım|demo|zoom|google meet|saat \d|uygun olur)/i, conf: 0.8 },
  { cls: 'interested', re: /(ilgileniyoruz|ilgileniyorum|ilgimi çekti|detay(lı)?\s*(bilgi)?\s*(alabilir|verir|alsak|rica|istiyor)|bilgi (alabilir|rica|istiyor)|fiyat|nasıl çalışıyor|merak ettim|olabilir)/i, conf: 0.75 },
  { cls: 'question', re: /\?/, conf: 0.5 }
];

export function classifyByRules(subject: string, body: string): { classification: ReplyClass; confidence: number } {
  const text = `${subject}\n${stripQuoted(body)}`;
  for (const r of RULES) if (r.re.test(text)) return { classification: r.cls, confidence: r.conf };
  return { classification: 'unknown', confidence: 0.3 };
}

/** Alıntılanan önceki mesajı ve imzayı kaba biçimde ayıklar. */
export function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^(>|On .* wrote:|.* tarihinde .* yazdı:|-----Original Message-----|From: |Kimden: )/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}
