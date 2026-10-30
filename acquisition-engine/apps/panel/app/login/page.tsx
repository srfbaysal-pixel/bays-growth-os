'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('/api/auth/login', { method: 'POST', json: { email, password } }); router.push(params.get('next') || '/dashboard'); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-3">
      <h1 className="text-xl font-bold">BaysSystems Acquisition</h1>
      <p className="muted text-sm">Müşteri kazanım paneline giriş</p>
      <label className="block text-sm">E-posta<input className="input mt-1" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label className="block text-sm">Parola<input className="input mt-1" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {err && <div className="text-sm" style={{ color: 'var(--bad)' }} role="alert">{err}</div>}
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş yap'}</button>
    </form>
  );
}
export default function LoginPage() {
  return (<main className="min-h-dvh flex items-center justify-center p-4"><Suspense><LoginForm /></Suspense></main>);
}
