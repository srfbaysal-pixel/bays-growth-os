'use client';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { Stat, ErrorBox, Loading, Section } from '@/components/ui';
import { useApi, SECTOR_NAMES, fmtMoney } from '@/lib/api';

export default function Dashboard() {
  const [sector, setSector] = useState<string>('');
  const { data, error, loading } = useApi<any>(`/api/dashboard${sector ? `?sector=${sector}` : ''}`, [sector]);
  const t = data?.today; const y = data?.yesterday;
  const delta = (k: string) => (t && y ? (t[k] - y[k] >= 0 ? `+${t[k] - y[k]}` : `${t[k] - y[k]}`) + ' düne göre' : undefined);
  return (
    <Shell title="Özet">
      <div className="flex gap-2 overflow-x-auto">
        {[['', 'Tümü'], ...Object.entries(SECTOR_NAMES)].map(([k, v]) => (<button key={k} className={`btn btn-sm ${sector === k ? 'btn-primary' : ''}`} onClick={() => setSector(k)}>{v}</button>))}
      </div>
      <ErrorBox text={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          {data.mode.dry_run || !data.mode.live_outreach_enabled ? <div className="card text-sm" style={{ borderColor: 'var(--warn)' }}>Test modu: gönderimler sağlayıcıya gitmez (DRY_RUN={String(data.mode.dry_run)}, LIVE_OUTREACH_ENABLED={String(data.mode.live_outreach_enabled)}). Sayılar gerçek veritabanı kayıtlarıdır.</div> : null}
          <Section title={`Bugün (${data.day})`}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Yeni lead" value={t.leads_discovered} hint={delta('leads_discovered')} />
              <Stat label="Nitelikli" value={t.leads_qualified} hint={delta('leads_qualified')} />
              <Stat label="Onay bekleyen" value={t.approvals_pending} />
              <Stat label="Gönderim" value={t.sent} hint={t.dry_run ? `+${t.dry_run} kuru çalışma` : delta('sent')} />
              <Stat label="Yanıt" value={t.replies} hint={`${t.replies_interested} ilgili · ${t.replies_rejected} ret`} />
              <Stat label="Görüşme talebi" value={t.meetings} />
              <Stat label="Teklif" value={t.quotes_sent} hint={`${t.quotes_accepted} kabul`} />
              <Stat label="Satış" value={t.deals_won} hint={`${t.deals_lost} kayıp`} />
            </div>
          </Section>
          <Section title="Son 7 gün">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Lead" value={data.week.totals.leads_discovered ?? 0} />
              <Stat label="Gönderim" value={data.week.totals.sent ?? 0} />
              <Stat label="Yanıt" value={data.week.totals.replies ?? 0} />
              <Stat label="Satış" value={data.week.totals.deals_won ?? 0} />
            </div>
            {data.week.days.length === 0 && <p className="muted text-sm">Haftalık özet için WF3 günlük metrik görevi henüz çalışmadı.</p>}
          </Section>
          <Section title="Huni (tüm zamanlar)">
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {['new', 'qualified', 'contacted', 'replied', 'customer', 'suppressed'].map((k) => (<Stat key={k} label={{ new: 'Yeni', qualified: 'Nitelikli', contacted: 'İletişim', replied: 'Yanıt', customer: 'Müşteri', suppressed: 'Engelli' }[k]!} value={data.funnel[k] ?? 0} />))}
            </div>
          </Section>
          <Section title="Sektörler">
            <div className="card overflow-x-auto"><table className="w-full text-sm"><thead><tr className="muted text-left"><th>Sektör</th><th>Lead</th><th>Nitelikli</th><th>İletişim</th><th>Müşteri</th></tr></thead><tbody>
              {data.by_sector.map((s: any) => (<tr key={s.key} className="border-t" style={{ borderColor: 'var(--border)' }}><td className="py-2">{s.name}</td><td>{s.leads}</td><td>{s.qualified}</td><td>{s.contacted}</td><td>{s.customers}</td></tr>))}
            </tbody></table></div>
          </Section>
          <Section title="Gelir"><div className="grid grid-cols-2 gap-2"><Stat label="Aylık yinelenen gelir (MRR)" value={fmtMoney(t.mrr_cents)} /><Stat label="Aktif abonelik" value={t.active_subscriptions} /></div></Section>
        </>
      )}
    </Shell>
  );
}
