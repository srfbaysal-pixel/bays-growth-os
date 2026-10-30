'use client';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { Badge, ErrorBox, Loading, Section, Stat } from '@/components/ui';
import { api, useApi, fmtDate } from '@/lib/api';

export default function Health() {
  const { data, error, loading, reload } = useApi<any>('/api/system');
  const [pre, setPre] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setMsg(null); try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <Shell title="Sistem">
      <ErrorBox text={error ?? msg} />
      {loading && !data ? <Loading /> : data && (<>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Stat label="Veritabanı" value={data.db_ok ? 'OK' : 'HATA'} />
          <Stat label="Gönderim" value={data.outreach_paused.paused ? 'DURDU' : 'Açık'} hint={data.outreach_paused.reason ?? undefined} />
          <Stat label="Onay bekleyen" value={data.approvals_pending} />
          <Stat label="Açık görev" value={data.open_tasks} />
        </div>
        <div className="card text-sm space-y-2">
          <div>Mod: DRY_RUN={String(data.mode.dry_run)} · LIVE_OUTREACH_ENABLED={String(data.mode.live_outreach_enabled)} · test alıcısı: {data.mode.test_recipients}</div>
          <div className="flex gap-2">
            {data.outreach_paused.paused ? <button className="btn btn-sm btn-primary" onClick={() => run(() => api('/api/system/outreach-pause', { method: 'POST', json: { paused: false } }))}>Gönderimi sürdür</button> : <button className="btn btn-sm btn-danger" onClick={() => { const reason = prompt('Durdurma nedeni:') ?? 'manuel'; void run(() => api('/api/system/outreach-pause', { method: 'POST', json: { paused: true, reason } })); }}>Gönderimi durdur</button>}
            <button className="btn btn-sm" onClick={() => run(async () => setPre(await api('/api/system/email-preflight')))}>E-posta ön kontrol</button>
          </div>
          {pre && (<div className="space-y-1"><div className="font-semibold">Sağlayıcı: {pre.provider.ok ? 'OK' : 'HATA'} — {pre.provider.detail}</div>{pre.checks.map((c: any) => (<div key={c.name} className="flex gap-2"><span className={c.ok === true ? '' : c.ok === false ? '' : 'muted'} style={{ color: c.ok === true ? 'var(--ok)' : c.ok === false ? 'var(--bad)' : undefined }}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}</span><span>{c.name}: <span className="muted">{c.detail}</span></span></div>))}</div>)}
        </div>
        <Section title="E-posta (24 saat)">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Kabul edilen" value={data.email.sent24h} />
            <Stat label="Bounce/şikâyet" value={data.email.bounced24h} hint={`oran %${(data.email.bounceRate * 100).toFixed(1)}`} />
            <Stat label="Ardışık hata" value={data.email.consecutiveErrors} />
            <Stat label="Kota" value={`${data.email.dayCount}/${data.email.daily_quota}`} hint={`saatlik ${data.email.hourCount}/${data.email.hourly_quota} · ${data.email.provider}`} />
          </div>
        </Section>
        <Section title="Workflow durumu">
          {data.workflows.length ? <div className="card text-sm space-y-2">{data.workflows.map((w: any) => (<div key={w.workflow_key}><div className="flex justify-between gap-2"><span className="font-semibold">{w.workflow_key}</span><Badge s={w.status} /></div><div className="muted text-xs">{fmtDate(w.started_at)} · {w.run_id}{w.error ? ` · ${w.error}` : ''}</div>{w.stats && Object.keys(w.stats).length > 0 && <details><summary className="text-xs cursor-pointer">istatistik</summary><pre className="text-xs overflow-x-auto">{JSON.stringify(w.stats, null, 1)}</pre></details>}</div>))}</div> : <div className="card muted text-sm">Henüz workflow çalışmadı (n8n workflow'larını içe aktarıp çalıştırın).</div>}
        </Section>
        <Section title="Kuyruk"><div className="card text-sm">{Object.keys(data.queue).length ? Object.entries(data.queue).map(([k, v]: any) => (<div key={k} className="flex justify-between"><span>{k}</span><span>{v}</span></div>)) : <span className="muted">Kuyruk boş</span>}<div className="muted text-xs mt-1">Eşleşmeyen gelen e-posta (7 gün): {data.unmatched_inbound_7d}</div></div></Section>
        <Section title="Entegrasyonlar"><div className="card text-sm space-y-1">{data.integrations.map((i: any) => (<div key={i.key} className="flex justify-between gap-2"><span>{i.key} <span className="muted text-xs">{i.detail}</span></span><Badge s={i.status} kind={['live', 'verified'].includes(i.status) ? 'ok' : ['error', 'degraded', 'disconnected'].includes(i.status) ? 'bad' : 'warn'} /></div>))}</div></Section>
        <Section title="Son e-posta hataları">{data.recent_errors.length ? <div className="card text-sm space-y-1">{data.recent_errors.map((e: any, i: number) => (<div key={i} className="text-xs"><span className="muted">{fmtDate(e.occurred_at)}</span> {e.to_address}: {e.detail?.error ?? JSON.stringify(e.detail)}</div>))}</div> : <div className="card muted text-sm">Hata yok</div>}</Section>
      </>)}
    </Shell>
  );
}
