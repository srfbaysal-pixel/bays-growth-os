-- BaysSystems Acquisition Engine — ilk şema
-- Tüm tablolar yeni, izole 'bays_acq' veritabanında yaşar. Mevcut n8n DB'sine dokunulmaz.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Kullanıcılar ve oturumlar ────────────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('owner','operator','viewer')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          text,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- ── Yapılandırma: sektörler, hizmet kataloğu, fiyat planları ────────────────
CREATE TABLE sectors (
  key        text PRIMARY KEY,
  name       text NOT NULL,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  sector_fit  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {sector_key: weight}
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key       text NOT NULL REFERENCES services(key),
  name              text NOT NULL,
  setup_fee_cents   bigint NOT NULL DEFAULT 0 CHECK (setup_fee_cents >= 0),
  monthly_fee_cents bigint NOT NULL DEFAULT 0 CHECK (monthly_fee_cents >= 0),
  currency          text NOT NULL DEFAULT 'TRY',
  is_active         boolean NOT NULL DEFAULT true,
  valid_from        date NOT NULL DEFAULT CURRENT_DATE,
  notes             text,
  UNIQUE (service_key, name)
);

-- ── Kaynaklar ────────────────────────────────────────────────────────────────
CREATE TABLE sources (
  key        text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('api','web','csv','manual')),
  terms_url  text,
  is_allowed boolean NOT NULL DEFAULT true,
  notes      text
);

-- ── İşletmeler ve kişiler ────────────────────────────────────────────────────
CREATE TABLE businesses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector_key       text NOT NULL REFERENCES sectors(key),
  name             text NOT NULL,
  normalized_name  text NOT NULL,
  dedup_key        text NOT NULL UNIQUE,     -- place_id | domain | phone | name+city
  website          text,
  domain           text,
  phone_e164       text,
  email_public     text,
  city             text,
  district         text,
  address          text,
  google_place_id  text UNIQUE,
  instagram_handle text,
  rating           numeric(3,2),
  review_count     integer,
  status           text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','qualified','disqualified','contacted','replied','customer','suppressed')),
  lead_score       integer NOT NULL DEFAULT 0,
  score_breakdown  jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_service_key text REFERENCES services(key),
  discovered_via   text REFERENCES sources(key),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_sector_status_idx ON businesses(sector_key, status);
CREATE INDEX businesses_score_idx ON businesses(lead_score DESC);
CREATE INDEX businesses_domain_idx ON businesses(domain) WHERE domain IS NOT NULL;
CREATE INDEX businesses_phone_idx ON businesses(phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX businesses_name_city_idx ON businesses(normalized_name, city);

CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  full_name        text,
  role_title       text,
  email            text,
  email_normalized text,
  phone_e164       text,
  source_key       text REFERENCES sources(key),
  is_primary       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, email_normalized)
);
CREATE INDEX contacts_email_idx ON contacts(email_normalized) WHERE email_normalized IS NOT NULL;

-- ── Araştırma kanıtı: doğrulanmış gözlem ≠ AI çıkarımı ───────────────────────
CREATE TABLE research_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_key   text NOT NULL REFERENCES sources(key),
  kind         text NOT NULL CHECK (kind IN ('observation','inference')),
  field        text NOT NULL,                 -- ör. has_whatsapp_link, has_online_booking
  value        jsonb NOT NULL,
  confidence   numeric(4,3) NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence_url text,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source_key, kind, field)
);
CREATE INDEX research_evidence_business_idx ON research_evidence(business_id);

CREATE TABLE lead_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  score         integer NOT NULL,
  breakdown     jsonb NOT NULL,
  model_version text NOT NULL,
  scored_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_scores_business_idx ON lead_scores(business_id, scored_at DESC);

-- ── İzinler, kanal uygunluğu, engelleme ──────────────────────────────────────
CREATE TABLE channel_permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('email','whatsapp','instagram','linkedin','phone')),
  status       text NOT NULL CHECK (status IN ('unknown','allowed','opt_in','opt_out','blocked')),
  basis        text,                 -- ör. 'public_business_contact', 'explicit_opt_in', 'iys'
  evidence_url text,
  verified_by  uuid REFERENCES users(id),
  verified_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_permissions_uniq
  ON channel_permissions(business_id, COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid), channel);

CREATE TABLE suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('email','domain','phone','business','instagram','linkedin')),
  value      text NOT NULL,
  reason     text NOT NULL,
  source     text NOT NULL DEFAULT 'manual',  -- manual | reply | bounce | complaint | import
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

-- ── Mesaj taslakları ve onay ─────────────────────────────────────────────────
CREATE TABLE message_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  channel         text NOT NULL CHECK (channel IN ('email','whatsapp','instagram','linkedin','phone')),
  service_key     text REFERENCES services(key),
  subject         text,
  body            text NOT NULL,
  facts_used      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- research_evidence id listesi
  generator       text NOT NULL DEFAULT 'template',     -- template | llm
  validation      jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_decision jsonb NOT NULL DEFAULT '{}'::jsonb,   -- kanal politikası sonucu
  status          text NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval','approved','rejected','queued','sent','manual_task','cancelled','blocked')),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  rejected_reason text,
  version         integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL UNIQUE,                 -- business+channel+sequence
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_drafts_status_idx ON message_drafts(status, created_at);
CREATE INDEX message_drafts_business_idx ON message_drafts(business_id);

CREATE TABLE approval_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id   uuid NOT NULL REFERENCES message_drafts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  action     text NOT NULL CHECK (action IN ('approve','reject','edit')),
  diff       jsonb,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Gönderim işleri ve olayları ──────────────────────────────────────────────
CREATE TABLE send_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            uuid NOT NULL UNIQUE REFERENCES message_drafts(id),   -- idempotency: taslak başına tek iş
  business_id         uuid NOT NULL REFERENCES businesses(id),
  contact_id          uuid REFERENCES contacts(id),
  channel             text NOT NULL,
  to_address          text NOT NULL,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sending','accepted','delivered','bounced','failed','blocked','dry_run')),
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  last_error          text,
  provider            text,
  provider_message_id text,
  message_id          text UNIQUE,            -- RFC 5322 Message-ID (yanıt eşleştirme)
  reply_token         text NOT NULL UNIQUE,   -- reply+<token>@domain
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX send_jobs_status_idx ON send_jobs(status, next_attempt_at);
CREATE INDEX send_jobs_provider_msg_idx ON send_jobs(provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE send_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_job_id       uuid NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  event             text NOT NULL CHECK (event IN ('queued','attempt','accepted','delivered','bounce','complaint','reject','error','blocked','dry_run','replied')),
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_event_id text UNIQUE,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX send_events_job_idx ON send_events(send_job_id, occurred_at);
CREATE INDEX send_events_event_time_idx ON send_events(event, occurred_at);

CREATE TABLE email_quota_usage (
  bucket     text NOT NULL,     -- 'day:2026-10-30' | 'hour:2026-10-30T14'
  provider   text NOT NULL,
  sent_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, provider)
);

-- ── Gelen yanıtlar ───────────────────────────────────────────────────────────
CREATE TABLE inbound_messages (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel                   text NOT NULL,
  provider_message_id       text,
  dedup_hash                text NOT NULL UNIQUE,
  from_address              text NOT NULL,
  to_address                text,
  subject                   text,
  body_text                 text NOT NULL DEFAULT '',
  in_reply_to               text,
  references_header         text,
  reply_token               text,
  matched_business_id       uuid REFERENCES businesses(id),
  matched_contact_id        uuid REFERENCES contacts(id),
  matched_send_job_id       uuid REFERENCES send_jobs(id),
  match_method              text,   -- reply_token | message_id | contact_email | domain | none
  classification            text CHECK (classification IN ('interested','rejected','question','meeting_request','out_of_office','bounce','unknown')),
  classification_confidence numeric(4,3),
  classified_by             text,   -- rules | llm | human
  needs_human_review        boolean NOT NULL DEFAULT false,
  received_at               timestamptz NOT NULL DEFAULT now(),
  processed_at              timestamptz,
  raw_headers               jsonb
);
CREATE INDEX inbound_business_idx ON inbound_messages(matched_business_id, received_at DESC);
CREATE INDEX inbound_unprocessed_idx ON inbound_messages(processed_at) WHERE processed_at IS NULL;

-- ── Satış: fırsatlar, görevler, teklifler, abonelikler ───────────────────────
CREATE TABLE deals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stage          text NOT NULL DEFAULT 'new'
                 CHECK (stage IN ('new','contacted','interested','meeting','proposal','negotiation','won','lost')),
  service_key    text REFERENCES services(key),
  value_cents    bigint,
  currency       text NOT NULL DEFAULT 'TRY',
  source         text,
  owner_user_id  uuid REFERENCES users(id),
  lost_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
CREATE INDEX deals_stage_idx ON deals(stage, updated_at DESC);
CREATE UNIQUE INDEX deals_one_open_per_business ON deals(business_id) WHERE stage NOT IN ('won','lost');

CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid REFERENCES businesses(id) ON DELETE CASCADE,
  deal_id       uuid REFERENCES deals(id) ON DELETE SET NULL,
  draft_id      uuid REFERENCES message_drafts(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('manual_outreach','follow_up','call','meeting','compliance_check','review_reply','other')),
  channel       text,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  due_at        timestamptz,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  assigned_to   uuid REFERENCES users(id),
  dedup_key     text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX tasks_open_idx ON tasks(status, due_at) WHERE status = 'open';

CREATE TABLE quotes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id           uuid REFERENCES price_plans(id),
  service_key       text REFERENCES services(key),
  setup_fee_cents   bigint NOT NULL DEFAULT 0,
  monthly_fee_cents bigint NOT NULL DEFAULT 0,
  discount_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  currency          text NOT NULL DEFAULT 'TRY',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  valid_until       date,
  sent_at           timestamptz,
  decided_at        timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_deal_idx ON quotes(deal_id);

CREATE TABLE subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  quote_id          uuid REFERENCES quotes(id),
  service_key       text NOT NULL REFERENCES services(key),
  plan_id           uuid REFERENCES price_plans(id),
  monthly_fee_cents bigint NOT NULL DEFAULT 0,
  setup_fee_cents   bigint NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'TRY',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','paused','cancelled')),
  started_at        date NOT NULL DEFAULT CURRENT_DATE,
  cancelled_at      date,
  next_billing_at   date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_status_idx ON subscriptions(status);

-- ── Referans / marka videosu kampanyası ──────────────────────────────────────
CREATE TABLE referral_campaigns (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id          uuid REFERENCES subscriptions(id),
  logo_url                 text,
  brand_info               jsonb NOT NULL DEFAULT '{}'::jsonb,
  video_template           text,
  video_status             text NOT NULL DEFAULT 'not_started'
                           CHECK (video_status IN ('not_started','brief_ready','in_production','uploaded','customer_review','approved','published')),
  video_url                text,
  customer_approval_status text NOT NULL DEFAULT 'pending' CHECK (customer_approval_status IN ('pending','approved','rejected')),
  customer_approved_at     timestamptz,
  share_verified           boolean NOT NULL DEFAULT false,
  share_url                text,
  share_verified_at        timestamptz,
  share_verified_by        uuid REFERENCES users(id),
  discount_pct             numeric(5,2) NOT NULL DEFAULT 10,
  discount_status          text NOT NULL DEFAULT 'pending' CHECK (discount_status IN ('pending','eligible','applied','void')),
  accounting_status        text NOT NULL DEFAULT 'none' CHECK (accounting_status IN ('none','credited','invoiced')),
  repost_permission        boolean NOT NULL DEFAULT false,
  compliance_status        text NOT NULL DEFAULT 'not_required' CHECK (compliance_status IN ('not_required','pending','approved','rejected')),
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, subscription_id)
);

-- ── Operasyon: denetim, iş akışı çalışmaları, bayraklar, entegrasyon durumu ──
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  text NOT NULL CHECK (actor_type IN ('user','system','n8n')),
  actor_id    text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  before_data jsonb,
  after_data  jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_log_time_idx ON audit_log(created_at DESC);

CREATE TABLE workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key text NOT NULL,          -- wf1_discovery | wf2_outreach | wf3_replies | api_sender
  run_id       text NOT NULL UNIQUE,   -- n8n execution id veya CLI run id (idempotency)
  status       text NOT NULL CHECK (status IN ('running','succeeded','failed','partial')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text
);
CREATE INDEX workflow_runs_key_idx ON workflow_runs(workflow_key, started_at DESC);

CREATE TABLE system_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE integration_status (
  key        text PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('disconnected','mock','configured','verified','live','degraded','error')),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,
  event_id    text NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, event_id)
);

CREATE TABLE daily_metrics (
  day         date NOT NULL,
  sector_key  text NOT NULL DEFAULT 'all',
  metrics     jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, sector_key)
);

-- updated_at tetikleyicisi
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses','message_drafts','send_jobs','deals','subscriptions','referral_campaigns'] LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- Varsayılan bayraklar
INSERT INTO system_flags(key, value, updated_by) VALUES
  ('outreach_paused', '{"paused": false, "reason": null}'::jsonb, 'migration'),
  ('schema_version', '"0001"'::jsonb, 'migration');
