import { promises as dns } from 'node:dns';
import type { Config } from '../config.js';

export interface PreflightCheck { name: string; ok: boolean | null; detail: string }

/**
 * SPF / DKIM / DMARC / MX ve gönderici hizalaması kontrolleri.
 * DKIM seçici bilinmediğinden yaygın seçiciler denenir; bulunamazsa "bilinmiyor" (null) döner.
 */
export async function runEmailPreflight(cfg: Config, opts: { resolveTxt?: (n: string) => Promise<string[][]>; resolveMx?: (n: string) => Promise<Array<{ exchange: string; priority: number }>>; dkimSelectors?: string[] } = {}): Promise<PreflightCheck[]> {
  const resolveTxt = opts.resolveTxt ?? ((n: string) => dns.resolveTxt(n));
  const resolveMx = opts.resolveMx ?? ((n: string) => dns.resolveMx(n));
  const fromDomain = cfg.EMAIL_FROM_ADDRESS.split('@')[1] ?? '';
  const replyDomain = cfg.EMAIL_REPLY_DOMAIN;
  const checks: PreflightCheck[] = [];
  const txt = async (name: string) => { try { return (await resolveTxt(name)).map((r) => r.join('')); } catch { return [] as string[]; } };

  checks.push({ name: 'config.provider', ok: cfg.EMAIL_PROVIDER !== 'mock', detail: `EMAIL_PROVIDER=${cfg.EMAIL_PROVIDER}` });
  checks.push({ name: 'config.flags', ok: true, detail: `DRY_RUN=${cfg.DRY_RUN} LIVE_OUTREACH_ENABLED=${cfg.LIVE_OUTREACH_ENABLED} TEST_RECIPIENTS=${cfg.TEST_RECIPIENTS.length}` });
  checks.push({ name: 'alignment.reply_domain', ok: replyDomain === fromDomain || replyDomain.endsWith('.' + fromDomain) || fromDomain.endsWith('.' + replyDomain), detail: `from=${fromDomain} reply=${replyDomain}` });

  const spf = (await txt(fromDomain)).find((t) => t.startsWith('v=spf1'));
  checks.push({ name: 'dns.spf', ok: Boolean(spf), detail: spf ?? `SPF kaydı yok: ${fromDomain}` });
  if (spf && /\+all/.test(spf)) checks.push({ name: 'dns.spf.strict', ok: false, detail: 'SPF "+all" içeriyor (güvensiz)' });

  const dmarc = (await txt(`_dmarc.${fromDomain}`)).find((t) => t.startsWith('v=DMARC1'));
  checks.push({ name: 'dns.dmarc', ok: Boolean(dmarc), detail: dmarc ?? `_dmarc.${fromDomain} yok` });
  if (dmarc && /p=none/.test(dmarc)) checks.push({ name: 'dns.dmarc.policy', ok: null, detail: 'DMARC p=none: izleme modunda; soğuk e-posta için en az p=quarantine önerilir' });

  const selectors = opts.dkimSelectors ?? ['default', 'selector1', 'selector2', 'google', 'resend', 'mail', 'k1', 'dkim', 's1', 's2'];
  let dkimFound: string | null = null;
  for (const s of selectors) {
    const r = (await txt(`${s}._domainkey.${fromDomain}`)).find((t) => /v=DKIM1|k=rsa|p=/.test(t));
    if (r) { dkimFound = s; break; }
  }
  checks.push({ name: 'dns.dkim', ok: dkimFound ? true : null, detail: dkimFound ? `DKIM seçici bulundu: ${dkimFound}` : 'Yaygın seçicilerle DKIM bulunamadı; sağlayıcının seçicisini elle doğrulayın' });

  try {
    const mx = await resolveMx(replyDomain);
    checks.push({ name: 'dns.mx.reply_domain', ok: mx.length > 0, detail: mx.map((m) => m.exchange).join(', ') || 'MX yok (yanıtlar alınamaz)' });
  } catch (e) { checks.push({ name: 'dns.mx.reply_domain', ok: false, detail: (e as Error).message }); }
  return checks;
}
