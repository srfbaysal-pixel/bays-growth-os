export interface OutgoingEmail {
  to: string;
  from: { name: string; address: string };
  replyTo: string;
  subject: string;
  text: string;
  messageId: string;       // RFC Message-ID, biz üretiriz (yanıt eşleştirme)
  headers?: Record<string, string>;
  idempotencyKey: string;  // send_job id
}
export interface SendResult { accepted: boolean; providerMessageId?: string | null; detail?: unknown }
export interface EmailProvider {
  key: string;
  send(msg: OutgoingEmail): Promise<SendResult>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}
