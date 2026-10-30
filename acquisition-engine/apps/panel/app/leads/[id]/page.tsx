'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { Badge, ErrorBox, Loading, Section } from '@/components/ui';
import { api, useApi, SECTOR_NAMES, fmtDate, tr } from '@/lib/api';

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<any>(`/api/leads/${id}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(null); try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const suppress = () => { const reason = prompt('Engelleme nedeni (tüm kanallarda uygulanır):'); if (reason) void act(() => api(`/api/leads/${id}/suppress`, { method: 'POST', json: { reason } })); };
  const setPerm = (channel: string, status: string) => act(() => api(`/api/leads/${id}/permissions`, { method: 'POST', json: { channel, status, basis: 'panel' } }));
  const addContact = () => { const email = prompt('Kişi e-postası:'); if (email) void act(() => api(`/api/leads/${id}/contacts`, { method: 'POST', json: { email } })); };
  if (error) return <Shell title="Lead"><ErrorBox text={error} /></Shell>;
  if (loading || !data) return <Shell title="Lead"><Loading /></Shell>;
  const b = data.business;
  const obs = data.evidence.filter((e: any) => e.kind === 'observation');
  const inf = data.evidence.filter((e: any) => e.kind === 'inference');
  return (
    <Shell title={b.name}>
      <ErrorBox text={msg} />
      <div className="card space-y-1">
        <div className="flex items-center justify-between"><Badge s={b.status} /><div className="font-bold text-xl">{b.lead_score} <span className="text-xs muted">puan</span></div></div>
        <div className="text-sm">{SECTOR_NAMES[b.sector_key] ?? b.sector_key} · {b.city ?? '—'}{b.district ? ` / ${b.district}` : ''}</div>
        {b.address && <div className="text-sm muted">{b.address}</div>}
        <div className="text-sm space-y-0.5">
          {b.website && <div>Web: <a className="underline" href={b.website} target="_blank" rel="noreferrer noopener">{b.website}</a></div>}
          {b.phone_e164 && <div>Tel: <a className="underline" href={`tel:${b.phone_e164}`}>{b.phone_e164}</a></div>}
          {b.email_public && <div>E-posta: {b.email_public}</div>}
          {b.instagram_handle && <div>Instagram: @{b.instagram_handle}</div>}
          {b.rating != null && <div>Google: {b.rating} ★ ({b.review_count ?? 0} yorum)</div>}
          {b.recommended_service_key && <div>Önerilen hizmet: <b>{b.recommended_service_key}</b></div>}
        </div>
        <div className="flex gap-2 pt-2 flex-wrap"><button className="btn btn-sm" onClick={addContact} disabled={busy}>Kişi ekle</button><button className="btn btn-sm btn-danger" onClick={suppress} disabled={busy || b.status === 'suppressed'}>Engelle (tüm kanallar)</button></div>
      </div>
      <Section title="Puan dökümü">
        <div className="card text-sm space-y-1">{Object.entries(b.score_breakdown ?? {}).map(([k, v]: any) => (<div key={k} className="flex justify-between gap-2"><span>{v.label} <span className="muted text-xs">({v.basis === 'inference' ? 'çıkarım' : v.basis === 'observation' ? 'gözlem' : 'veri yok'})</span></span><span className={v.hit ? 'font-semibold' : 'muted'}>{v.hit ? `+${v.weight}` : '0'}</span></div>))}</div>
      </Section>
      <Section title="Doğrulanmış gözlemler">
        {obs.length ? <div className="card text-sm space-y-1">{obs.map((e: any) => (<div key={e.id} className="flex justify-between gap-2"><span>{e.field}</span><span>{JSON.stringify(e.value)} <span className="muted text-xs">{e.source_key}</span></span></div>))}</div> : <div className="muted text-sm">Yok</div>}
      </Section>
      <Section title="AI çıkarımları (doğrulanmamış)">
        {inf.length ? <div className="card text-sm space-y-1">{inf.map((e: any) => (<div key={e.id} className="flex justify-between gap-2"><span>{e.field}</span><span>{JSON.stringify(e.value)} <span className="muted text-xs">güven {Math.round(Number(e.confidence) * 100)}%</span></span></div>))}</div> : <div className="muted text-sm">Yok</div>}
      </Section>
      <Section title="Kanal izinleri">
        <div className="card text-sm space-y-2">
          {['email', 'whatsapp', 'instagram', 'linkedin', 'phone'].map((ch) => { const p = data.permissions.find((x: any) => x.channel === ch); return (<div key={ch} className="flex items-center justify-between gap-2"><span>{ch} <Badge s={p?.status ?? 'unknown'} kind={p?.status === 'opt_in' || p?.status === 'allowed' ? 'ok' : p?.status === 'opt_out' || p?.status === 'blocked' ? 'bad' : 'warn'} /></span><span className="flex gap-1"><button className="btn btn-sm" disabled={busy} onClick={() => setPerm(ch, 'opt_in')}>Opt-in</button><button className="btn btn-sm" disabled={busy} onClick={() => setPerm(ch, 'opt_out')}>Opt-out</button></span></div>); })}
          <p className="muted text-xs">Opt-in yalnız belgelenebilir açık rıza varsa işaretlenmeli (İYS/KVKK).</p>
        </div>
      </Section>
      <Section title="Kişiler">{data.contacts.length ? <div className="card text-sm">{data.contacts.map((c: any) => (<div key={c.id}>{c.full_name ?? '—'} · {c.email ?? ''} {c.phone_e164 ?? ''} <span className="muted text-xs">{c.source_key}</span></div>))}</div> : <div className="muted text-sm">Kişi yok</div>}</Section>
      <Section title="Mesajlar">{data.drafts.length ? <div className="card text-sm space-y-1">{data.drafts.map((d: any) => (<div key={d.id} className="flex justify-between gap-2"><Link className="underline" href={`/approvals?focus=${d.id}`}>{d.subject ?? d.channel}</Link><Badge s={d.status} /></div>))}</div> : <div className="muted text-sm">Taslak yok</div>}</Section>
      <Section title="Fırsatlar ve görevler">
        <div className="card text-sm space-y-1">
          {data.deals.map((d: any) => (<div key={d.id} className="flex justify-between"><span>Fırsat · {d.service_key ?? '—'}</span><Badge s={d.stage} /></div>))}
          {data.tasks.map((t: any) => (<div key={t.id} className="flex justify-between"><span>{t.title}</span><Badge s={t.status} /></div>))}
          {!data.deals.length && !data.tasks.length && <span className="muted">Yok</span>}
        </div>
      </Section>
      <Section title="Gelen yanıtlar">{data.inbound.length ? <div className="card text-sm space-y-1">{data.inbound.map((i: any) => (<div key={i.id} className="flex justify-between gap-2"><span className="truncate">{i.from_address} · {i.subject ?? ''}</span><span className="shrink-0"><Badge s={i.classification} /> <span className="muted text-xs">{fmtDate(i.received_at)}</span></span></div>))}</div> : <div className="muted text-sm">Yok</div>}</Section>
      {data.suppressions.length > 0 && <div className="card text-sm" style={{ borderColor: 'var(--bad)' }}>Engelleme: {data.suppressions.map((s: any) => `${s.kind}:${s.value} (${s.reason})`).join(', ')}</div>}
      <div className="muted text-xs">Oluşturma: {fmtDate(b.created_at)} · {tr(b.status)}</div>
    </Shell>
  );
}
