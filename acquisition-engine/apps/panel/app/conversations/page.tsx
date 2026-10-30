'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { Badge, Empty, ErrorBox, Loading, Section } from '@/components/ui';
import { api, useApi, fmtDate, fmtMoney, tr } from '@/lib/api';

export default function Conversations() {
  const { data, error, loading, reload } = useApi<any>('/api/conversations');
  const [tab, setTab] = useState<'inbound' | 'tasks' | 'deals' | 'quotes'>('tasks');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setMsg(null); try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } };
  const manualReply = () => { const from = prompt('Gönderen e-posta:'); if (!from) return; const text = prompt('Yanıt metni:'); if (!text) return; void run(() => api('/api/inbound/manual', { method: 'POST', json: { from, text } })); };
  const newQuote = (dealId: string) => { const monthly = prompt('Aylık ücret (TL):'); if (monthly == null) return; const setup = prompt('Kurulum ücreti (TL):', '0'); const discount = prompt('İndirim % (referans kampanyası için 10):', '0'); void run(() => api('/api/quotes', { method: 'POST', json: { deal_id: dealId, monthly_fee_cents: Math.round(Number(monthly) * 100), setup_fee_cents: Math.round(Number(setup ?? 0) * 100), discount_pct: Number(discount ?? 0) } })); };
  return (
    <Shell title="Satış">
      <div className="flex gap-2 overflow-x-auto">{([['tasks', 'Görevler'], ['inbound', 'Yanıtlar'], ['deals', 'Fırsatlar'], ['quotes', 'Teklifler']] as const).map(([k, v]) => (<button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>{v}{data ? ` (${data[k].length})` : ''}</button>))}</div>
      <ErrorBox text={error ?? msg} />
      {loading && !data ? <Loading /> : data && (
        <>
          {tab === 'tasks' && (data.tasks.length ? data.tasks.map((t: any) => (
            <div key={t.id} className="card space-y-1">
              <div className="flex justify-between gap-2"><div className="font-semibold">{t.title}</div><Badge s={t.kind} kind="warn" /></div>
              {t.business_name && <div className="text-xs muted">{t.business_name} · {t.channel ?? ''} · son: {fmtDate(t.due_at)}</div>}
              {t.description && <details><summary className="text-sm cursor-pointer">Detay</summary><pre className="msg mt-1 text-sm">{t.description}</pre></details>}
              <div className="flex gap-2"><button className="btn btn-sm btn-primary" onClick={() => run(() => api(`/api/tasks/${t.id}/complete`, { method: 'POST', json: { status: 'done' } }))}>Tamamlandı</button><button className="btn btn-sm" onClick={() => run(() => api(`/api/tasks/${t.id}/complete`, { method: 'POST', json: { status: 'cancelled' } }))}>İptal</button>{t.business_id && <Link className="btn btn-sm" href={`/leads/${t.business_id}`}>Lead</Link>}</div>
            </div>)) : <Empty text="Açık görev yok." />)}
          {tab === 'inbound' && (<>
            <button className="btn btn-sm" onClick={manualReply}>Yanıt gir (manuel)</button>
            {data.inbound.length ? data.inbound.map((i: any) => (
              <div key={i.id} className="card space-y-1">
                <div className="flex justify-between gap-2"><div className="font-semibold truncate">{i.business_name ?? <span className="muted">Eşleşmedi</span>}</div><Badge s={i.classification} /></div>
                <div className="text-xs muted">{i.from_address} · {i.subject ?? ''} · {fmtDate(i.received_at)} · eşleşme: {i.match_method}{i.needs_human_review ? ' · inceleme gerekli' : ''}</div>
                <details><summary className="text-sm cursor-pointer">Mesaj</summary><pre className="msg mt-1 text-sm">{i.body_text}</pre></details>
                {i.business_id && <Link className="underline text-sm" href={`/leads/${i.business_id}`}>Lead'e git</Link>}
              </div>)) : <Empty text="Henüz yanıt yok." />}
          </>)}
          {tab === 'deals' && (data.deals.length ? data.deals.map((d: any) => (
            <div key={d.id} className="card space-y-1">
              <div className="flex justify-between gap-2"><Link href={`/leads/${d.business_id}`} className="font-semibold underline">{d.business_name}</Link><Badge s={d.stage} /></div>
              <div className="text-xs muted">{d.service_name ?? d.service_key ?? '—'} · {d.value_cents ? fmtMoney(d.value_cents) : 'değer yok'} · {fmtDate(d.updated_at)}</div>
              {!['won', 'lost'].includes(d.stage) && (<div className="flex gap-1 flex-wrap">
                <select className="input" style={{ minHeight: 36, width: 'auto' }} value={d.stage} onChange={(e) => { const stage = e.target.value; const lost_reason = stage === 'lost' ? prompt('Kayıp nedeni:') : undefined; void run(() => api(`/api/deals/${d.id}/stage`, { method: 'POST', json: { stage, lost_reason: lost_reason ?? null } })); }}>{data.stages.map((s: string) => <option key={s} value={s}>{tr(s === 'new' ? 'new_deal' : s)}</option>)}</select>
                <button className="btn btn-sm" onClick={() => newQuote(d.id)}>Teklif oluştur</button>
              </div>)}
            </div>)) : <Empty text="Fırsat yok." />)}
          {tab === 'quotes' && (data.quotes.length ? data.quotes.map((q: any) => (
            <div key={q.id} className="card space-y-1">
              <div className="flex justify-between gap-2"><div className="font-semibold">{q.business_name}</div><Badge s={q.status} /></div>
              <div className="text-xs muted">{q.service_key} · kurulum {fmtMoney(q.setup_fee_cents)} · aylık {fmtMoney(q.monthly_fee_cents)} · indirim %{q.discount_pct}</div>
              {['draft', 'sent'].includes(q.status) && <div className="flex gap-1">{q.status === 'draft' && <button className="btn btn-sm" onClick={() => run(() => api(`/api/quotes/${q.id}/status`, { method: 'POST', json: { status: 'sent' } }))}>Gönderildi</button>}<button className="btn btn-sm btn-primary" onClick={() => run(() => api(`/api/quotes/${q.id}/status`, { method: 'POST', json: { status: 'accepted' } }))}>Kabul edildi</button><button className="btn btn-sm" onClick={() => run(() => api(`/api/quotes/${q.id}/status`, { method: 'POST', json: { status: 'rejected' } }))}>Reddedildi</button></div>}
            </div>)) : <Empty text="Teklif yok." />)}
        </>
      )}
    </Shell>
  );
}
