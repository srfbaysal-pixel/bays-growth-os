'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const NAV = [
  { href: '/dashboard', label: 'Özet', icon: '▦' },
  { href: '/leads', label: 'Leadler', icon: '☷' },
  { href: '/approvals', label: 'Onaylar', icon: '✓' },
  { href: '/conversations', label: 'Satış', icon: '✉' },
  { href: '/revenue', label: 'Gelir', icon: '₺' },
  { href: '/health', label: 'Sistem', icon: '♥' }
];

export function Shell({ children, title }: { children: React.ReactNode; title: string }) {
  const path = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<{ user: { email: string; role: string } | null; mode: { dry_run: boolean; live_outreach_enabled: boolean } } | null>(null);
  useEffect(() => { api('/api/auth/me').then(setMe).catch(() => undefined); }, []);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); router.push('/login'); };
  const testMode = me?.mode ? me.mode.dry_run || !me.mode.live_outreach_enabled : true;
  return (
    <div className="min-h-dvh md:flex">
      <aside className="hidden md:flex md:flex-col md:w-56 md:border-r p-4 gap-1 sticky top-0 h-dvh" style={{ borderColor: 'var(--border)', background: 'var(--card)' }}>
        <div className="font-bold text-lg mb-3">BaysSystems</div>
        {NAV.map((n) => (<Link key={n.href} href={n.href} className={`rounded-lg px-3 py-2 ${path.startsWith(n.href) ? 'font-bold' : 'muted'}`} style={path.startsWith(n.href) ? { background: 'var(--brand-soft)' } : {}}>{n.icon} {n.label}</Link>))}
        <div className="mt-auto text-xs muted">{me?.user?.email}<br />{me?.user?.role}</div>
        <button className="btn btn-sm mt-2" onClick={logout}>Çıkış</button>
      </aside>
      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between" style={{ background: 'var(--card)', borderBottom: '1px solid var(--border)', paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
          <h1 className="font-bold text-lg">{title}</h1>
          <div className="flex items-center gap-2">
            {me && (<span className={`badge ${testMode ? 'badge-warn' : 'badge-ok'}`} title={testMode ? 'DRY_RUN veya LIVE_OUTREACH_ENABLED=false: gerçek gönderim yok' : 'Canlı gönderim açık'}>{testMode ? 'TEST MODU' : 'CANLI'}</span>)}
            <button className="btn btn-sm md:hidden" onClick={logout} aria-label="Çıkış">⎋</button>
          </div>
        </header>
        <main className="p-4 space-y-4 pb-24 md:pb-6 max-w-5xl">{children}</main>
        <nav className="md:hidden fixed bottom-0 inset-x-0 flex z-10" style={{ background: 'var(--card)', borderTop: '1px solid var(--border)', paddingBottom: 'env(safe-area-inset-bottom)' }} aria-label="Ana gezinme">
          {NAV.map((n) => (<Link key={n.href} href={n.href} className={`navlink ${path.startsWith(n.href) ? 'active' : ''}`}><span className="text-lg" aria-hidden>{n.icon}</span>{n.label}</Link>))}
        </nav>
      </div>
    </div>
  );
}
