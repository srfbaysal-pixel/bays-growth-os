import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailProvider, OutgoingEmail, SendResult } from './types.js';

export class SmtpEmailProvider implements EmailProvider {
  key = 'smtp';
  private transporter: Transporter;
  constructor(opts: { host: string; port: number; secure: boolean; user?: string; pass?: string }) {
    this.transporter = nodemailer.createTransport({
      host: opts.host, port: opts.port, secure: opts.secure,
      auth: opts.user ? { user: opts.user, pass: opts.pass ?? '' } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      tls: { rejectUnauthorized: true }
    });
  }
  async send(msg: OutgoingEmail): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: { name: msg.from.name, address: msg.from.address },
      to: msg.to, replyTo: msg.replyTo, subject: msg.subject, text: msg.text,
      messageId: msg.messageId,
      headers: { 'X-Bays-Idempotency': msg.idempotencyKey, 'List-Unsubscribe': `<mailto:${msg.replyTo}?subject=hayir>`, ...(msg.headers ?? {}) }
    });
    const accepted = (info.accepted ?? []).length > 0;
    return { accepted, providerMessageId: info.messageId ?? null, detail: { response: info.response, rejected: info.rejected } };
  }
  async verify() {
    try { await this.transporter.verify(); return { ok: true, detail: 'SMTP bağlantısı ve kimlik doğrulama başarılı' }; }
    catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}
