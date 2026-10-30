'use client';
import { tr } from '@/lib/api';

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (<div className="card stat"><b>{value}</b><span>{label}</span>{hint && <span className="muted">{hint}</span>}</div>);
}
export function Badge({ s, kind }: { s: string | null | undefined; kind?: 'ok' | 'warn' | 'bad' }) {
  const auto = kind ?? (s && ['qualified', 'customer', 'won', 'succeeded', 'accepted', 'delivered', 'active', 'interested', 'meeting_request', 'approved', 'sent', 'done'].includes(s) ? 'ok'
    : s && ['suppressed', 'rejected', 'lost', 'failed', 'bounced', 'blocked', 'bounce', 'disqualified'].includes(s) ? 'bad'
    : s && ['pending_approval', 'manual_task', 'running', 'partial', 'queued', 'dry_run', 'question', 'unknown', 'open', 'pending'].includes(s) ? 'warn' : undefined);
  return <span className={`badge ${auto ? 'badge-' + auto : ''}`}>{tr(s)}</span>;
}
export function Empty({ text }: { text: string }) { return <div className="card muted text-center py-8">{text}</div>; }
export function ErrorBox({ text }: { text: string | null }) { return text ? <div className="card" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>{text}</div> : null; }
export function Loading() { return <div className="muted p-4 text-center">Yükleniyor…</div>; }
export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (<section className="space-y-2"><div className="flex items-center justify-between"><h2 className="font-semibold text-base">{title}</h2>{right}</div>{children}</section>);
}
