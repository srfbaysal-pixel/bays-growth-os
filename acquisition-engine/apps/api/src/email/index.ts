import type { Config } from '../config.js';
import { MockEmailProvider } from './mock.js';
import { ResendEmailProvider } from './resend.js';
import { SmtpEmailProvider } from './smtp.js';
import type { EmailProvider } from './types.js';

export function makeEmailProvider(cfg: Config): EmailProvider {
  if (cfg.EMAIL_PROVIDER === 'smtp') {
    if (!cfg.SMTP_HOST) throw new Error('EMAIL_PROVIDER=smtp için SMTP_HOST gerekli');
    return new SmtpEmailProvider({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_SECURE, user: cfg.SMTP_USER, pass: cfg.SMTP_PASS });
  }
  if (cfg.EMAIL_PROVIDER === 'resend') {
    if (!cfg.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER=resend için RESEND_API_KEY gerekli');
    return new ResendEmailProvider(cfg.RESEND_API_KEY);
  }
  return new MockEmailProvider();
}
export type { EmailProvider, OutgoingEmail, SendResult } from './types.js';
