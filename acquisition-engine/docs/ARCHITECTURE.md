# Mimari ve teknik tasarım

## 1. Kararlar (özet)

| Karar | Seçim | Gerekçe |
| --- | --- | --- |
| Çalışma modeli | **İnce n8n, kalın API** | n8n yalnız zamanlama/tetikleme/IMAP yapar; iş mantığı test edilebilir TypeScript API'de. n8n düğüm sürümü değişse bile mantık bozulmaz; mevcut n8n kurulumuna yalnızca 3 workflow eklenir. |
| Servis sayısı | 2 yeni süreç (API + panel) + mevcut Postgres'te yeni DB | Sınırlı VPS kaynağı. Tahmini: API ~80–120 MB, panel ~120–180 MB RSS. Ayrı Postgres konteyneri **isteğe bağlı** (`--profile db`). |
| API | Node 22 + Fastify 5 + `pg` + `zod` | Hafif, bağımlılık az (4 runtime paketi). ORM yok; SQL açık ve denetlenebilir. |
| Panel | Next.js 15 (App Router) + Tailwind 4, `output: standalone` | PWA (manifest + SW), mobil öncelikli; veri her zaman API'den (sahte metrik yok). |
| Veritabanı | PostgreSQL 16, `bays_acq` adlı **ayrı** veritabanı | Mevcut n8n DB'sine dokunulmaz. Migration'lar düz SQL, `schema_migrations` tablosu. |
| Kimlik | Çerez oturumu (httpOnly, SameSite=Lax), scrypt parola, rol: owner/operator/viewer | Sunucu tarafı yetki her uçta (`requireUser(role)`). CSRF: Origin kontrolü veya `x-requested-with`. |
| n8n ↔ API | HMAC-SHA256 (`X-Bays-Timestamp` + `X-Bays-Signature`), 5 dk pencere, `run_id` ile idempotent | Yeniden deneme güvenli; panel oturumu iç uçlara erişemez. |
| AI | Adaptör (`anthropic` \| `mock`), şema doğrulamalı çıktı, hatada şablona düşüş | AI kapalıyken sistem tamamen çalışır. Taslaklar yalnız **doğrulanmış gözlem** kullanabilir. |
| E-posta | Adaptör (`smtp` \| `resend` \| `mock`), iş kuyruğu, kill-switch, kota, idempotency | Geçmiş gönderim sorunları nedeniyle gönderim asla "varsayılmaz": her adım olay olarak kaydedilir. |
| Keşif | Adaptör (`google_places` \| `mock` \| `csv`) + web sitesi gözlemi (robots.txt'ye saygı) | Yalnız resmî/izinli kaynaklar; Instagram/LinkedIn kazıma yok. |
| Sektör bağımsızlık | `config/sectors/*.json` | Yeni sektör = yeni JSON (sinyaller, ağırlıklar, eşik, hizmet tercihi, uyumluluk). Kod değişmez. |

## 2. Veri akışı

```
WF1 (n8n cron) ─HMAC─▶ /internal/wf1/run ─▶ discovery adapter ─▶ normalize + dedup ─▶ research_evidence(observation)
                                              └▶ website fetch ─▶ observation          └▶ AI infer ─▶ research_evidence(inference)
                                              └▶ computeScore(sector) ─▶ lead_scores, businesses.status=qualified|disqualified

WF2 (n8n cron) ─HMAC─▶ /internal/wf2/prepare ─▶ recommendService ─▶ draft (AI|template) ─▶ validateDraft ─▶ decidePolicy ─▶ message_drafts(pending_approval)
Panel (insan)  ─────▶ /api/approvals/:id/approve ─▶ decidePolicy (tekrar) ─▶ send_jobs(queued) | tasks(manual_outreach) | blocked
WF2 (n8n cron) ─HMAC─▶ /internal/wf2/send ─▶ processSendQueue: lock → policy → quota → DRY_RUN? → provider.send → send_events

WF3 (n8n IMAP) ─HMAC─▶ /internal/wf3/inbound ─▶ match (reply+token | Message-ID | contact email | domain) ─▶ classify ─▶ deals/tasks/suppressions
WF3 (n8n cron) ─HMAC─▶ /internal/wf3/metrics ─▶ daily_metrics
Sağlayıcı webhook ───▶ /webhooks/email/resend (svix imza), /webhooks/whatsapp (X-Hub-Signature-256)
```

## 3. Dosya yapısı

```
acquisition-engine/
├── apps/api/src
│   ├── config.ts                 # zod ile doğrulanan ortam; DRY_RUN her zaman baskın
│   ├── db/{pool,migrate}.ts
│   ├── auth/service.ts           # scrypt, oturum, roller
│   ├── sectors/loader.ts         # config/sectors/*.json → DB
│   ├── catalog/services.ts       # hizmet kataloğu + öneri kuralı
│   ├── discovery/{places,mock,csv,website,pipeline}.ts
│   ├── scoring/score.ts          # saf puanlama fonksiyonu (gözlem ≠ çıkarım)
│   ├── ai/{types,anthropic,mock}.ts
│   ├── outreach/{templates,validate,policy,drafts,approvals,sender,killswitch}.ts
│   ├── email/{smtp,resend,mock,preflight}.ts
│   ├── inbound/{classify,process}.ts
│   ├── sales/{deals,tasks,quotes,referral}.ts
│   ├── metrics/daily.ts · health/status.ts
│   ├── workflows/{wf1,wf2,wf3}.ts # n8n'in çağırdığı orkestrasyon
│   ├── http/{server,plugins,routes/*}.ts
│   └── cli.ts · index.ts
├── apps/api/tests/*.test.ts      # 62 test (gerçek PostgreSQL)
├── apps/panel/app/{dashboard,leads,approvals,conversations,revenue,health,login}
├── apps/panel/e2e/panel.spec.ts  # Playwright (Pixel 7 + masaüstü)
├── db/migrations/*.sql
├── config/sectors/{education,beauty,clinic}.json · config/services.json
├── n8n/WF{1,2,3}_*.json          # tools/build-n8n.mjs ile üretilir
├── deploy/{Caddyfile.snippet,Dockerfile.*,systemd/*,scripts/*}
└── docs/*.md · IMPLEMENTATION_STATUS.md
```

## 4. Geliştirme sırası (uygulanan)

1. Şema ve migration → 2. yapılandırma/sektör/katalog → 3. keşif + normalize + dedup → 4. puanlama → 5. AI adaptörleri → 6. taslak + doğrulama + politika → 7. onay + gönderim kuyruğu + kill-switch → 8. e-posta adaptörleri + DNS ön kontrol → 9. gelen yanıt eşleştirme/sınıflandırma → 10. satış (fırsat/görev/teklif/abonelik/referans) → 11. metrik + sağlık → 12. HTTP + güvenlik → 13. testler → 14. n8n JSON üretici → 15. panel + PWA + e2e → 16. dağıtım + dokümanlar.

## 5. Sunucu kaynak riskleri

| Risk | Etki | Önlem |
| --- | --- | --- |
| RAM baskısı (n8n + Caddy + Postgres + 2 yeni süreç) | OOM, mevcut otomasyonların yavaşlaması | Compose'da 256 MB bellek limitleri; systemd `MemoryMax`; panel `standalone`; API havuzu max 8 bağlantı. Kurulum öncesi `deploy/scripts/preflight.sh` ile `free -m` kontrolü. 2 GB RAM altı sunucuda ayrı Postgres konteyneri önerilmez. |
| Postgres bağlantı sayısı | n8n ile paylaşımda `max_connections` | API 8, test 4 bağlantı. Gerekirse PgBouncer. |
| Web sitesi tarama | CPU/IO, hedef sitelere yük | 1 istek/sn, 8 sn zaman aşımı, 600 KB sınırı, yalnız ana sayfa + iletişim sayfası, robots.txt. |
| Google Places maliyeti | Fatura | `GOOGLE_PLACES_DAILY_LIMIT` (DB sayaçlı), sayfa boyutu ≤ 20. |
| AI maliyeti | Fatura | `AI_DAILY_CALL_LIMIT`, mock varsayılan. |
| Disk | Audit/olay tabloları büyür | Günlük yedekte 14 gün saklama; `audit_log` için aylık arşiv önerisi (TROUBLESHOOTING). |
| n8n yürütme geçmişi | n8n DB büyür | Workflow ayarlarında yürütme verisi saklama süresini kısaltın. |

## 6. Güvenlik özeti

HTTPS (Caddy) · httpOnly/SameSite çerez · scrypt parola · rol tabanlı yetki her uçta · rate limit (genel + login) · HMAC imzalı iç uçlar (zaman penceresi, sabit zamanlı karşılaştırma) · svix/X-Hub-Signature webhook doğrulaması · zod girdi doğrulama · parametreli SQL (injection yok) · React kaçışlama + CSP (XSS) · güvenlik başlıkları · audit_log · sırlar yalnız ortam değişkeninde · yedekleme/geri yükleme betikleri.
