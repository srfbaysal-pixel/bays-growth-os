import type { EmailProvider, OutgoingEmail, SendResult } from './types.js';

export class MockEmailProvider implements EmailProvider {
  key = 'mock';
  sent: OutgoingEmail[] = [];
  failNext = 0;
  async send(msg: OutgoingEmail): Promise<SendResult> {
    if (this.failNext > 0) { this.failNext--; throw new Error('mock: geçici SMTP hatası'); }
    this.sent.push(msg);
    return { accepted: true, providerMessageId: `mock-${this.sent.length}` };
  }
  async verify() { return { ok: true, detail: 'mock sağlayıcı (gerçek gönderim yok)' }; }
}
