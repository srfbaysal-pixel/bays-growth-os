'use client';
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'bays-panel', ...(init.headers as Record<string, string> ?? {}) };
  let body = init.body;
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(path, { ...init, headers, body, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) { window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Hata ${res.status}`, data.details);
  return data as T;
}

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError(null);
    try { setData(await api<T>(path)); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload, ...deps]);
  return { data, error, loading, reload };
}

export const fmtMoney = (cents: number | string | null | undefined, cur = 'TRY') => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(Number(cents ?? 0) / 100);
export const fmtDate = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(d)) : '—');
export const SECTOR_NAMES: Record<string, string> = { education: 'Eğitim', beauty: 'Güzellik', clinic: 'Klinik' };
export const STATUS_TR: Record<string, string> = {
  new: 'Yeni', qualified: 'Nitelikli', disqualified: 'Uygun değil', contacted: 'İletişim kuruldu', replied: 'Yanıtladı', customer: 'Müşteri', suppressed: 'Engellendi',
  pending_approval: 'Onay bekliyor', approved: 'Onaylandı', rejected: 'Reddedildi', queued: 'Kuyrukta', sent: 'Gönderildi', manual_task: 'Manuel görev', cancelled: 'İptal', blocked: 'Engellendi',
  interested: 'İlgili', question: 'Soru', meeting_request: 'Görüşme talebi', out_of_office: 'Ofis dışı', bounce: 'Geri döndü', unknown: 'Belirsiz',
  'new_deal': 'Yeni', meeting: 'Görüşme', proposal: 'Teklif', negotiation: 'Pazarlık', won: 'Kazanıldı', lost: 'Kaybedildi',
  draft: 'Taslak', accepted: 'Kabul', expired: 'Süresi doldu', active: 'Aktif', trial: 'Deneme', paused: 'Duraklatıldı',
  open: 'Açık', done: 'Tamam', running: 'Çalışıyor', succeeded: 'Başarılı', failed: 'Hata', partial: 'Kısmi', dry_run: 'Kuru çalışma', accepted_job: 'Kabul edildi', delivered: 'Teslim', bounced: 'Geri döndü'
};
export const tr = (s: string | null | undefined) => (s ? STATUS_TR[s] ?? s : '—');
