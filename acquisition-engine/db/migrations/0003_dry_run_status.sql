-- K3: DRY_RUN gönderimleri gerçek gönderimden kesin olarak ayrılır.
-- message_drafts.status için yeni değer: 'dry_run' (sağlayıcıya gitmedi, işletme durumu değişmedi).
ALTER TABLE message_drafts DROP CONSTRAINT message_drafts_status_check;
ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check
  CHECK (status IN ('pending_approval','approved','rejected','queued','sent','manual_task','cancelled','blocked','dry_run'));
-- Kill-switch için eşleşmeyen bounce sayımı (K4) ve dry_run raporlaması için indeks
CREATE INDEX IF NOT EXISTS inbound_bounce_unmatched_idx ON inbound_messages(received_at) WHERE classification = 'bounce' AND matched_send_job_id IS NULL;
