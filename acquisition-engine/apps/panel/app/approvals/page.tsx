'use client';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { Badge, Empty, ErrorBox, Loading } from '@/components/ui';
import { api, useApi, SECTOR_NAMES } from '@/lib/api';

function DraftCard({ d, onDone }: { d: any; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState<string>(d.subject ?? '');
  const [body, setBody] = useState<string>(d.body);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = async (fn: () => Promise<any>) => { setBusy(true); setMsg(null); try { const r = await fn(); if (r?.outcome) setResult(r.outcome === 'queued' ? 'Gönderim kuyruğuna alındı.' : r.outcome === 'manual_task' ? `Manuel iletişim görevi açıldı: ${r.reasons.join('; ')}` : `Engellendi: ${r.reasons.join('; ')}`); onDone(); } catch (e) { setMsg((e as Error).message + ((e as any).details ? ': ' + JSON.stringify((e as any).details) : '')); } finally { setBusy(false); } };
  const policy = d.policy_decision ?? {};
  const val = d.validation ?? {};
  return (
    <div className="card space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="font-semibold truncate">{d.business_name}</div><div className="muted text-xs">{SECTOR_NAMES[d.sector_key] ?? d.sector_key} · {d.city ?? '—'} · puan {d.lead_score} · {d.channel} → {d.to_email ?? 'adres yok'}</div></div>
        <Badge s={d.status} />
      </div>
      <div className="text-xs flex gap-1 flex-wrap">
        <span className="badge">{d.service_name ?? d.service_key}</span>
        <span className={`badge ${policy.mode === 'auto_send' ? 'badge-ok' : policy.mode === 'blocked' ? 'badge-bad' : 'badge-warn'}`}>{policy.mode === 'auto_send' ? 'Otomatik gönderilebilir' : policy.mode === 'blocked' ? 'Engelli' : 'Onayda manuel görev açılır'}</span>
        <span className="badge">{d.generator === 'llm' ? 'AI taslağı' : 'Şablon'}</span>
        {Array.isArray(val.warnings) && val.warnings.length > 0 && <span className="badge badge-warn">{val.warnings.length} uyarı</span>}
      </div>
      {policy.reasons?.length > 0 && <div className="muted text-xs">Politika: {policy.reasons.join('; ')}</div>}
      {editing ? (
        <div className="space-y-2">
          {d.channel === 'email' && <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Konu" />}
          <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex gap-2"><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(async () => { await api(`/api/approvals/${d.id}/edit`, { method: 'POST', json: { subject: d.channel === 'email' ? subject : null, body } }); setEditing(false); })}>Kaydet</button><button className="btn btn-sm" onClick={() => setEditing(false)}>Vazgeç</button></div>
        </div>
      ) : (
        <div>{d.subject && <div className="font-medium text-sm mb-1">Konu: {d.subject}</div>}<pre className="msg">{d.body}</pre></div>
      )}
      {msg && <div className="text-sm" style={{ color: 'var(--bad)' }}>{msg}</div>}
      {result && <div className="text-sm" style={{ color: 'var(--ok)' }}>{result}</div>}
      {d.status === 'pending_approval' && !editing && (
        <div className="grid grid-cols-3 gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api(`/api/approvals/${d.id}/approve`, { method: 'POST', json: {} }))}>Onayla</button>
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>Düzenle</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => { const reason = prompt('Ret nedeni:'); if (reason) void run(() => api(`/api/approvals/${d.id}/reject`, { method: 'POST', json: { reason } })); }}>Reddet</button>
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const [status, setStatus] = useState('pending_approval');
  const { data, error, loading, reload } = useApi<any>(`/api/approvals?status=${status}`, [status]);
  return (
    <Shell title="Onaylar">
      <div className="flex gap-2 overflow-x-auto">{[['pending_approval', 'Bekleyen'], ['manual_task', 'Manuel görev'], ['queued', 'Kuyrukta'], ['sent', 'Gönderilen'], ['rejected', 'Reddedilen'], ['blocked', 'Engelli']].map(([k, v]) => (<button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : ''}`} onClick={() => setStatus(k)}>{v}</button>))}</div>
      <ErrorBox text={error} />
      {loading && !data ? <Loading /> : !data?.items?.length ? <Empty text="Bu durumda taslak yok." /> : data.items.map((d: any) => <DraftCard key={d.id} d={d} onDone={reload} />)}
    </Shell>
  );
}
