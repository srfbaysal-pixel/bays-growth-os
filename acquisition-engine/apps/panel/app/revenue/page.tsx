'use client';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { Badge, Empty, ErrorBox, Loading, Section, Stat } from '@/components/ui';
import { api, useApi, fmtMoney, SECTOR_NAMES, tr } from '@/lib/api';

export default function Revenue() {
  const { data, error, loading, reload } = useApi<any>('/api/revenue');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setMsg(null); try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } };
  const patch = (id: string, json: any) => run(() => api(`/api/referrals/${id}`, { method: 'PATCH', json }));
  return (
    <Shell title="Gelir">
      <ErrorBox text={error ?? msg} />
      {loading && !data ? <Loading /> : data && (<>
        <div className="grid grid-cols-2 gap-2"><Stat label="MRR" value={fmtMoney(data.mrr_cents)} /><Stat label="Aktif abonelik" value={data.subscriptions.filter((s: any) => ['active', 'trial'].includes(s.status)).length} /></div>
        <Section title="Sektör performansı">
          <div className="card overflow-x-auto"><table className="w-full text-sm"><thead><tr className="muted text-left"><th>Sektör</th><th>Lead</th><th>Nitelikli</th><th>Satış</th><th>Aktif</th><th>MRR</th></tr></thead><tbody>
            {data.sectors.map((s: any) => { const b = data.by_sector.find((x: any) => x.sector_key === s.key); return (<tr key={s.key} className="border-t" style={{ borderColor: 'var(--border)' }}><td className="py-2">{s.name}</td><td>{s.leads}</td><td>{s.qualified}</td><td>{s.won}</td><td>{b?.active ?? 0}</td><td>{fmtMoney(b?.mrr_cents ?? 0)}</td></tr>); })}
          </tbody></table></div>
        </Section>
        <Section title="Aylık">{data.monthly.length ? <div className="card text-sm">{data.monthly.map((m: any) => (<div key={m.month} className="flex justify-between"><span>{m.month}</span><span>{m.new_subs} yeni · kurulum {fmtMoney(m.setup_cents)}</span></div>))}</div> : <Empty text="Henüz abonelik yok." />}</Section>
        <Section title="Abonelikler">{data.subscriptions.length ? data.subscriptions.map((s: any) => (<div key={s.id} className="card flex justify-between gap-2 text-sm"><div><div className="font-semibold">{s.business_name}</div><div className="muted text-xs">{s.service_name} · {SECTOR_NAMES[s.sector_key]} · başlangıç {s.started_at}</div></div><div className="text-right"><div>{fmtMoney(s.monthly_fee_cents)}/ay</div><Badge s={s.status} /></div></div>)) : <Empty text="Abonelik yok." />}</Section>
        <Section title="Referans / marka videosu kampanyası" right={<button className="btn btn-sm" onClick={() => { const business_id = prompt('İşletme ID (lead sayfasındaki URL):'); if (!business_id) return; const logo_url = prompt('Logo URL (opsiyonel):') || null; void run(() => api('/api/referrals', { method: 'POST', json: { business_id, logo_url } })); }}>Yeni</button>}>
          {data.referrals.length ? data.referrals.map((r: any) => (
            <div key={r.id} className="card space-y-1 text-sm">
              <div className="flex justify-between gap-2"><div className="font-semibold">{r.business_name}</div><span className="flex gap-1"><Badge s={r.video_status} /><Badge s={r.discount_status} kind={r.discount_status === 'applied' ? 'ok' : r.discount_status === 'eligible' ? 'warn' : undefined} /></span></div>
              <div className="muted text-xs">Müşteri onayı: {tr(r.customer_approval_status)} · Paylaşım: {r.share_verified ? 'doğrulandı' : 'bekliyor'} · Mevzuat: {tr(r.compliance_status)} · Muhasebe: {r.accounting_status} · Yeniden paylaşım izni: {r.repost_permission ? 'var' : 'yok'} · İndirim %{r.discount_pct}</div>
              {r.video_url && <a className="underline" href={r.video_url} target="_blank" rel="noreferrer noopener">Video</a>}
              <div className="flex gap-1 flex-wrap">
                {r.video_status === 'brief_ready' || r.video_status === 'in_production' ? <button className="btn btn-sm" onClick={() => { const video_url = prompt('Video URL:'); if (video_url) void patch(r.id, { video_status: 'uploaded', video_url }); }}>Video yükle</button> : null}
                {r.video_status === 'uploaded' && <button className="btn btn-sm" onClick={() => patch(r.id, { video_status: 'customer_review' })}>Müşteriye gönder</button>}
                {r.customer_approval_status !== 'approved' && <button className="btn btn-sm" onClick={() => patch(r.id, { customer_approval_status: 'approved' })}>Müşteri onayladı</button>}
                {r.video_status === 'customer_review' && <button className="btn btn-sm" onClick={() => patch(r.id, { video_status: 'approved' })}>Yayına hazır</button>}
                {!r.share_verified && <button className="btn btn-sm" onClick={() => { const share_url = prompt('Paylaşım URL:'); if (share_url) void patch(r.id, { share_url, share_verified: true }); }}>Paylaşımı doğrula</button>}
                {r.compliance_status === 'pending' && <button className="btn btn-sm" onClick={() => patch(r.id, { compliance_status: 'approved' })}>Mevzuat onayı</button>}
                {r.video_status === 'approved' && <button className="btn btn-sm btn-primary" onClick={() => patch(r.id, { video_status: 'published' })}>Yayınlandı</button>}
                {r.discount_status === 'eligible' && <button className="btn btn-sm btn-primary" onClick={() => patch(r.id, { discount_status: 'applied', accounting_status: 'credited' })}>İndirimi uygula</button>}
                <button className="btn btn-sm" onClick={() => patch(r.id, { repost_permission: !r.repost_permission })}>Yeniden paylaşım izni: {r.repost_permission ? 'kaldır' : 'ver'}</button>
              </div>
            </div>)) : <Empty text="Kampanya kaydı yok. Kurulum yapan müşteri için 'Yeni' ile başlatın." />}
        </Section>
      </>)}
    </Shell>
  );
}
