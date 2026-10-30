import type { EmailProvider, OutgoingEmail, SendResult } from './types.js';

/** Resend HTTP API adaptörü. Belge: https://resend.com/docs/api-reference/emails/send-email */
export class ResendEmailProvider implements EmailProvider {
  key = 'resend';
  constructor(private apiKey: string, private fetchFn: typeof fetch = fetch) {}
  async send(msg: OutgoingEmail): Promise<SendResult> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': msg.idempotencyKey },
      body: JSON.stringify({ from: `${msg.from.name} <${msg.from.address}>`, to: [msg.to], reply_to: msg.replyTo, subject: msg.subject, text: msg.text, headers: { 'Message-ID': msg.messageId, ...(msg.headers ?? {}) } })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { accepted: true, providerMessageId: (body as any).id ?? null, detail: body };
  }
  async verify() {
    const res = await this.fetchFn('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${this.apiKey}` } });
    return res.ok ? { ok: true, detail: 'Resend API anahtarı geçerli' } : { ok: false, detail: `Resend ${res.status}` };
  }
}
