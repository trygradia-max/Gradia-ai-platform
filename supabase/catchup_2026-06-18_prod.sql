-- ============================================================================
-- Gradia PRODUCTION catch-up — generated 2026-06-18
-- Target DB: zfxkzciumhrrgfeacwds.supabase.co
--
-- WHY: production's migration history records migrations 20260609110000 →
-- 20260618120000 as "applied", but the ADD COLUMN / type / policy changes in
-- them never actually landed (the CREATE TABLE statements did). `supabase db
-- push` therefore won't fix it. This script re-asserts ONLY the missing pieces.
--
-- SAFE TO RUN: every statement is idempotent (IF NOT EXISTS / ON CONFLICT /
-- guarded DO-blocks / DROP POLICY IF EXISTS). Re-running changes nothing.
-- Backfills only touch NULL rows. No data is dropped or overwritten.
-- NOT wrapped in a single transaction on purpose (ALTER TYPE ADD VALUE), so if
-- it's interrupted, just run it again — it'll resume cleanly.
--
-- HOW: paste into the Supabase dashboard → SQL Editor → Run. (This is an
-- operational catch-up, NOT a migration — do not add it to supabase/migrations.)
-- ============================================================================

-- ── 20260609110000 telephony_pricing_metering ──────────────────────────────
ALTER TABLE public.usage_events
  ADD COLUMN IF NOT EXISTS wholesale_cost numeric,
  ADD COLUMN IF NOT EXISTS retail_cost numeric,
  ADD COLUMN IF NOT EXISTS vendor_ref text;

CREATE INDEX IF NOT EXISTS usage_events_vendor_ref_idx
  ON public.usage_events (vendor_ref) WHERE vendor_ref IS NOT NULL;

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS twilio_subaccount_sid text,
  ADD COLUMN IF NOT EXISTS twilio_subaccount_token_enc text,
  ADD COLUMN IF NOT EXISTS gradia_number_e164 text,
  ADD COLUMN IF NOT EXISTS gradia_number_sid text,
  ADD COLUMN IF NOT EXISTS a2p_status text NOT NULL DEFAULT 'unregistered'
    CHECK (a2p_status IN ('unregistered', 'pending', 'approved', 'rejected'));

-- ── 20260611100000 voice_builder ───────────────────────────────────────────
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS voice_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_live boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_test_called_at timestamptz,
  ADD COLUMN IF NOT EXISTS vapi_phone_number_id text,
  ADD COLUMN IF NOT EXISTS vapi_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vapi_server_secret_enc text,
  ADD COLUMN IF NOT EXISTS voice_minutes_budget integer;

-- ── 20260611110000 pricing_skus (final kind-check, locked prices, voice add-on)
ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_kind_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_kind_check
  CHECK (kind IN (
    'agent_run', 'message', 'voice_minute', 'sms_segment', 'number_monthly',
    'email_send', 'outreach_draft', 'bi_answer', 'whisper_note', 'agentic_plan'
  ));

INSERT INTO public.pricing_config (key, wholesale_cents, retail_cents, note) VALUES
  ('sms_segment',    1.2, 4,  'Locked 2026-06-11: 4 credits per SMS segment'),
  ('email_send',     0.3, 1,  'Locked 2026-06-11: 1 credit per email send'),
  ('outreach_draft', 0.3, 1,  'Locked 2026-06-11: 1 credit per Haiku outreach draft'),
  ('bi_answer',      2.1, 7,  'Locked 2026-06-11: 7 credits per Ask Gradia answer'),
  ('whisper_note',   0.9, 3,  'Locked 2026-06-11: 3 credits per Whisper note'),
  ('agentic_plan',   3.0, 10, 'Locked 2026-06-11: 10 credits per agentic-mode plan'),
  ('voice_minute',   12,  25, 'Locked 2026-06-11: minutes meter, NOT credits — retail $10/40min pack'),
  ('number_monthly', 115, 250, 'Twilio local number ~$1.15/mo; folded into voice add-on')
ON CONFLICT (key) DO UPDATE
  SET wholesale_cents = EXCLUDED.wholesale_cents,
      retail_cents = EXCLUDED.retail_cents,
      note = EXCLUDED.note;

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS voice_addon boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_addon_ended_at timestamptz;

-- credit_grants: the allowance ledger (pack purchases + rollover). This CREATE
-- TABLE did NOT land in prod (PGRST205 "table not found in schema cache"),
-- unlike the other migration tables — so re-assert it here. Read by
-- src/lib/credits.ts, voice-provider.ts, and the Stripe webhook.
CREATE TABLE IF NOT EXISTS public.credit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('credit_pack', 'minute_pack', 'rollover')),
  credits integer NOT NULL DEFAULT 0,
  minutes integer NOT NULL DEFAULT 0,
  stripe_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_stripe_ref_key
  ON public.credit_grants (stripe_ref) WHERE stripe_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_grants_shop_period_idx
  ON public.credit_grants (shop_id, created_at DESC);
ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_grants_tenant_read ON public.credit_grants;
CREATE POLICY credit_grants_tenant_read ON public.credit_grants
  FOR SELECT USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- ── 20260611120000 reschedule_cancel (calendar-write action types) ──────────
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'reschedule_appointment';
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'cancel_appointment';

-- ── 20260614120000 shop_housecallpro (the CRM we added) ─────────────────────
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS housecallpro_account_id text,
  ADD COLUMN IF NOT EXISTS housecallpro_account_name text,
  ADD COLUMN IF NOT EXISTS housecallpro_access_token_enc text,
  ADD COLUMN IF NOT EXISTS housecallpro_refresh_token_enc text,
  ADD COLUMN IF NOT EXISTS housecallpro_token_expires_at timestamptz;
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS housecallpro_customer_id text;
CREATE INDEX IF NOT EXISTS customers_housecallpro_customer_id_idx
  ON public.customers (housecallpro_customer_id) WHERE housecallpro_customer_id IS NOT NULL;
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS housecallpro_job_id text;

-- ── 20260615130000 structured_segments (vehicle + last-visit + backfills) ───
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS vehicle_make text,
  ADD COLUMN IF NOT EXISTS vehicle_model text,
  ADD COLUMN IF NOT EXISTS vehicle_year int;
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS vehicle_make text,
  ADD COLUMN IF NOT EXISTS vehicle_model text,
  ADD COLUMN IF NOT EXISTS vehicle_year int,
  ADD COLUMN IF NOT EXISTS last_visit_at timestamptz;
CREATE INDEX IF NOT EXISTS leads_shop_vehicle_make_idx ON public.leads (shop_id, vehicle_make);
CREATE INDEX IF NOT EXISTS customers_shop_vehicle_make_idx ON public.customers (shop_id, vehicle_make);
CREATE INDEX IF NOT EXISTS customers_shop_last_visit_idx ON public.customers (shop_id, last_visit_at);

UPDATE public.leads
SET vehicle_year = (substring(car_info from '((?:19|20)[0-9]{2})'))::int
WHERE vehicle_year IS NULL AND car_info ~ '(19|20)[0-9]{2}';

UPDATE public.leads l
SET vehicle_make = m.make
FROM (VALUES
  ('tesla','Tesla'), ('toyota','Toyota'), ('honda','Honda'), ('ford','Ford'),
  ('chevrolet','Chevrolet'), ('chevy','Chevrolet'), ('bmw','BMW'),
  ('mercedes','Mercedes-Benz'), ('benz','Mercedes-Benz'), ('audi','Audi'),
  ('lexus','Lexus'), ('nissan','Nissan'), ('jeep','Jeep'), ('dodge','Dodge'),
  ('ram','Ram'), ('gmc','GMC'), ('subaru','Subaru'), ('hyundai','Hyundai'),
  ('kia','Kia'), ('porsche','Porsche'), ('mazda','Mazda'),
  ('volkswagen','Volkswagen'), ('vw','Volkswagen'), ('cadillac','Cadillac'),
  ('acura','Acura'), ('infiniti','Infiniti'), ('volvo','Volvo'),
  ('land rover','Land Rover'), ('range rover','Land Rover'),
  ('jaguar','Jaguar'), ('chrysler','Chrysler'), ('buick','Buick'),
  ('lincoln','Lincoln'), ('genesis','Genesis'), ('mini','Mini'),
  ('rivian','Rivian'), ('lucid','Lucid'), ('ferrari','Ferrari'),
  ('lamborghini','Lamborghini'), ('maserati','Maserati'), ('bentley','Bentley')
) AS m(pat, make)
WHERE l.vehicle_make IS NULL AND l.car_info ~* ('\y' || m.pat || '\y');

UPDATE public.customers c
SET vehicle_make = l.vehicle_make, vehicle_model = l.vehicle_model, vehicle_year = l.vehicle_year
FROM (
  SELECT DISTINCT ON (customer_id) customer_id, vehicle_make, vehicle_model, vehicle_year
  FROM public.leads WHERE customer_id IS NOT NULL
  ORDER BY customer_id, created_at DESC
) l
WHERE c.id = l.customer_id AND c.vehicle_make IS NULL AND l.vehicle_make IS NOT NULL;

UPDATE public.customers c
SET last_visit_at = a.last_at
FROM (
  SELECT customer_id, max(scheduled_at) AS last_at
  FROM public.appointments
  WHERE customer_id IS NOT NULL AND scheduled_at <= now()
  GROUP BY customer_id
) a
WHERE c.id = a.customer_id AND c.last_visit_at IS NULL;

-- ── 20260615140000 safe_send (quiet hours + consent) ────────────────────────
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS quiet_hours_start int NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS quiet_hours_end int NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS byo_sms_verified boolean NOT NULL DEFAULT false;
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_consent_source text,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at timestamptz;

-- ── 20260615150000 approval_resolution ──────────────────────────────────────
ALTER TABLE public.pending_actions ADD COLUMN IF NOT EXISTS resolution text;
CREATE INDEX IF NOT EXISTS pending_actions_resolution_idx
  ON public.pending_actions (shop_id, action_type, resolution);

-- ── 20260615160000 vehicle_color ────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS vehicle_color text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS vehicle_color text;

-- ── 20260616120000 customer_recovery (columns; tables/types guarded) ────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS last_transaction_at timestamptz,
  ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'import_source_type') THEN
    CREATE TYPE public.import_source_type AS ENUM ('mbox', 'contacts_csv', 'vcard', 'gradia_history');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'import_job_status') THEN
    CREATE TYPE public.import_job_status AS ENUM ('pending', 'parsing', 'estimating', 'extracting', 'ready', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  source_type public.import_source_type NOT NULL,
  file_ref text,
  status public.import_job_status NOT NULL DEFAULT 'pending',
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  estimated_credits int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_jobs_shop_id_idx ON public.import_jobs (shop_id);

CREATE TABLE IF NOT EXISTS public.import_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id uuid NOT NULL REFERENCES public.import_jobs (id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  message_id text,
  from_email text,
  subject text,
  body_ref text,
  has_list_unsubscribe boolean NOT NULL DEFAULT false,
  owner_participated boolean NOT NULL DEFAULT false,
  kept boolean NOT NULL DEFAULT true,
  drop_reason text,
  extraction jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_messages_job_idx ON public.import_messages (import_job_id);
CREATE INDEX IF NOT EXISTS import_messages_shop_idx ON public.import_messages (shop_id);

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_jobs_tenant_isolation ON public.import_jobs;
CREATE POLICY import_jobs_tenant_isolation ON public.import_jobs
  FOR ALL USING (shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())))
  WITH CHECK (shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS import_messages_tenant_isolation ON public.import_messages;
CREATE POLICY import_messages_tenant_isolation ON public.import_messages
  FOR ALL USING (shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())))
  WITH CHECK (shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())));

-- ── 20260616130000 recovery_storage (private bucket) ────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('recovery-imports', 'recovery-imports', false)
ON CONFLICT (id) DO NOTHING;

-- ── 20260618120000 appointment_confirm ──────────────────────────────────────
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirm_pending_action_id uuid;
CREATE INDEX IF NOT EXISTS appointments_confirm_pending_idx
  ON public.appointments (scheduled_at) WHERE confirm_pending_action_id IS NULL;

-- ============================================================================
-- Done. Verify with the probe in the chat, or spot-check:
--   SELECT housecallpro_account_id, voice_addon, a2p_status FROM public.shops LIMIT 1;
--   SELECT do_not_contact, vehicle_make FROM public.customers LIMIT 1;
--   SELECT confirmed_at FROM public.appointments LIMIT 1;
-- ============================================================================
