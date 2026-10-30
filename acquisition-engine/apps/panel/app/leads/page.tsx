'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { Badge, Empty, ErrorBox, Loading } from '@/components/ui';
import { useApi, SECTOR_NAMES } from '@/lib/api';

export default function Leads() {
  const [sector, setSector] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = new URLSearchParams(); if (sector) q.set('sector', sector); if (status) q.set('status', status); if (search) q.set('search', search);
  const { data, error, loading } = useApi<any>(`/api/leads?${q.toString()}`, [sector, status, search]);
  return (
    <Shell title="Leadler">
      <div className="space-y-2">
        <input className="input" placeholder="İşletme veya şehir ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-2 overflow-x-auto">{[['', 'Tüm sektörler'], ...Object.entries(SECTOR_NAMES)].map(([k, v]) => (<button key={k} className={`btn btn-sm ${sector === k ? 'btn-primary' : ''}`} onClick={() => setSector(k)}>{v}</button>))}</div>
        <div className="flex gap-2 overflow-x-auto">{[['', 'Tüm durumlar'], ['qualified', 'Nitelikli'], ['contacted', 'İletişim'], ['replied', 'Yanıtladı'], ['customer', 'Müşteri'], ['disqualified', 'Uygun değil'], ['suppressed', 'Engelli']].map(([k, v]) => (<button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : ''}`} onClick={() => setStatus(k)}>{v}</button>))}</div>
      </div>
      <ErrorBox text={error} />
      {loading && !data ? <Loading /> : !data?.items?.length ? <Empty text="Kayıt yok. WF1 keşif workflow'unu çalıştırın veya CSV içe aktarın." /> : (
        <div className="space-y-2">
          <div className="muted text-xs">{data.total} kayıt</div>
          {data.items.map((b: any) => (
            <Link key={b.id} href={`/leads/${b.id}`} className="card block">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><div className="font-semibold truncate">{b.name}</div><div className="muted text-xs">{SECTOR_NAMES[b.sector_key] ?? b.sector_key} · {b.city ?? '—'}{b.district ? ` / ${b.district}` : ''}</div></div>
                <div className="text-right shrink-0"><div className="font-bold">{b.lead_score}</div><div className="text-[10px] muted">puan</div></div>
              </div>
              <div className="flex gap-1 mt-2 flex-wrap"><Badge s={b.status} />{b.deal_stage && <Badge s={b.deal_stage} />}{b.email_public && <span className="badge">e-posta</span>}{b.instagram_handle && <span className="badge">instagram</span>}{b.phone_e164 && <span className="badge">telefon</span>}</div>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  );
}
