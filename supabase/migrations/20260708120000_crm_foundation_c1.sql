-- CRM Foundation C1 — schema per _docs/GRADIA_CRM_FOUNDATION_SPEC.md (P9).
--
-- Everything here is ADDITIVE and idempotent. No existing column is dropped
-- or rewritten; legacy flat vehicle columns and the old lead_status column
-- stay in place until the C1 code phase migrates their callers.
--
-- Open decision #1 (pipeline stages vs production lead_status) resolved by
-- the data: lead_status is ENUM('new','quoted','booked') → maps losslessly
-- to the 6-stage pipeline (new→new, quoted→quote_sent, booked→booked).
-- lead_status is NOT touched; `stage` is a new column and the new source of
-- truth once the code phase lands.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.crm_stage AS ENUM
    ('new', 'needs_quote', 'quote_sent', 'follow_up', 'booked', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.crm_lost_reason AS ENUM
    ('price', 'timing', 'no_response', 'competitor', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.customer_lifecycle AS ENUM
    ('lead', 'active', 'maintenance', 'at_risk', 'lapsed', 'won_back');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.vehicle_size_class AS ENUM
    ('sedan', 'coupe', 'truck_suv', 'xl_van', 'exotic', 'rv', 'boat', 'motorcycle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.quote_status AS ENUM
    ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.job_status AS ENUM
    ('booked', 'confirmed', 'checked_in', 'in_progress', 'on_hold',
     'completed', 'paid', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.job_hold_reason AS ENUM
    ('customer', 'weather', 'parts', 'payment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.job_location_type AS ENUM ('shop', 'mobile');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.job_payment_status AS ENUM ('unpaid', 'deposit', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.automation_mode AS ENUM ('approval', 'autopilot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.automation_run_status AS ENUM
    ('staged', 'approved', 'sent', 'dismissed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- vehicles — first-class vehicle profiles (spec §7). One customer, many
-- vehicles. Protection status (coating/ppf/tint) + maintenance_schedule
-- carry the maintenance clock that drives P9.5 retention automations.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  year integer,
  make text,
  model text,
  trim text,
  color text,
  size_class public.vehicle_size_class,
  plate text,
  vin text,
  photos text[] NOT NULL DEFAULT '{}',
  paint_condition smallint CHECK (paint_condition BETWEEN 1 AND 5),
  paint_condition_note text,
  interior_condition smallint CHECK (interior_condition BETWEEN 1 AND 5),
  interior_condition_note text,
  coating jsonb,               -- {applied, brand, applied_at, warranty_months, last_inspection_at}
  ppf jsonb,                   -- {coverage, brand, applied_at}
  tint jsonb,                  -- {film, pct, applied_at}
  maintenance_schedule jsonb NOT NULL DEFAULT '[]', -- [{service_id, interval_months, next_due_at}]
  notes text,
  import_job_id uuid REFERENCES public.import_jobs (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicles_shop_id_idx ON public.vehicles (shop_id);
CREATE INDEX IF NOT EXISTS vehicles_customer_id_idx ON public.vehicles (customer_id);
CREATE INDEX IF NOT EXISTS vehicles_shop_make_idx ON public.vehicles (shop_id, make);

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vehicles_tenant_isolation ON public.vehicles;
CREATE POLICY vehicles_tenant_isolation ON public.vehicles
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- Backfill: one vehicle per customer that has flat vehicle columns. Legacy
-- columns stay; the code phase repoints readers/writers to this table.
INSERT INTO public.vehicles (shop_id, customer_id, year, make, model, color)
SELECT c.shop_id, c.id, c.vehicle_year, c.vehicle_make, c.vehicle_model, c.vehicle_color
FROM public.customers c
WHERE c.vehicle_make IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.vehicles v WHERE v.customer_id = c.id);

-- -----------------------------------------------------------------------------
-- customers — lifecycle + retention fields (spec §5.4). Lifecycle is derived
-- by code (nightly); the backfill below is a best-evidence seed from
-- last_transaction_at (P8 column), defaulting to 'active'.
-- -----------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS lifecycle public.customer_lifecycle NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS lifetime_value_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jobs_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_service_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_recommended_service_id uuid REFERENCES public.services (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_recommended_at timestamptz,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

UPDATE public.customers
SET lifecycle = CASE
  WHEN last_transaction_at IS NULL THEN 'active'::public.customer_lifecycle
  WHEN last_transaction_at > now() - interval '6 months' THEN 'active'
  WHEN last_transaction_at > now() - interval '12 months' THEN 'at_risk'
  ELSE 'lapsed'
END
WHERE lifecycle = 'active';

CREATE INDEX IF NOT EXISTS customers_shop_lifecycle_idx
  ON public.customers (shop_id, lifecycle);

-- -----------------------------------------------------------------------------
-- leads — becomes the pipeline card (spec §6). stage is the new source of
-- truth; lead_status remains untouched for existing readers until the code
-- phase. customer_id backfilled by exact phone match; unmatched leads get
-- linked by find_or_create_customer in the code phase.
-- -----------------------------------------------------------------------------
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage public.crm_stage,
  ADD COLUMN IF NOT EXISTS stage_entered_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stage_history jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES public.vehicles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_interest_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS est_value_cents integer,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS lost_reason public.crm_lost_reason,
  ADD COLUMN IF NOT EXISTS urgency text,
  ADD COLUMN IF NOT EXISTS next_action_at timestamptz;

UPDATE public.leads
SET stage = CASE status
  WHEN 'new' THEN 'new'::public.crm_stage
  WHEN 'quoted' THEN 'quote_sent'
  WHEN 'booked' THEN 'booked'
END
WHERE stage IS NULL;

UPDATE public.leads l
SET customer_id = c.id
FROM public.customers c
WHERE l.customer_id IS NULL
  AND c.shop_id = l.shop_id
  AND c.phone IS NOT NULL
  AND c.phone = l.phone;

CREATE INDEX IF NOT EXISTS leads_shop_stage_idx ON public.leads (shop_id, stage);
CREATE INDEX IF NOT EXISTS leads_next_action_idx ON public.leads (shop_id, next_action_at);
CREATE INDEX IF NOT EXISTS leads_customer_id_idx ON public.leads (customer_id);

-- -----------------------------------------------------------------------------
-- quotes — the money object (spec §8). public_token backs the branded quote
-- page (/q/[token]); viewed_at set on first open. created_by records actor
-- provenance (owner | agent | whisper) — agent-created quotes are ALWAYS
-- draft (staged), enforced in code, asserted in the C1 test phase.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES public.vehicles (id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads (id) ON DELETE SET NULL,
  status public.quote_status NOT NULL DEFAULT 'draft',
  line_items jsonb NOT NULL DEFAULT '[]',  -- [{service_id, qty, base_cents, modifiers[], price_cents}]
  subtotal_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  is_range boolean NOT NULL DEFAULT false,
  range_low_cents integer,
  range_high_cents integer,
  customer_note text,
  internal_note text,
  photos text[] NOT NULL DEFAULT '{}',
  valid_until date,
  sent_via text,                           -- sms | email | both
  sent_at timestamptz,
  viewed_at timestamptz,
  responded_at timestamptz,
  created_by text NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner', 'agent', 'whisper')),
  -- 32 hex chars (~122 bits) without a pgcrypto dependency.
  public_token text UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotes_shop_status_idx ON public.quotes (shop_id, status);
CREATE INDEX IF NOT EXISTS quotes_customer_id_idx ON public.quotes (customer_id);

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quotes_tenant_isolation ON public.quotes;
CREATE POLICY quotes_tenant_isolation ON public.quotes
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- Now that quotes exists, the pipeline card can point at one.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quotes (id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- appointments — becomes the job (spec §9). One object, two faces
-- (appointment = when/where, job = work status). Backfill: confirmed_at
-- (no-show ladder, NEXT-2) → 'confirmed', else 'booked'. No guessing about
-- completion — code/owners advance past that.
-- -----------------------------------------------------------------------------
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES public.vehicles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quotes (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status public.job_status,
  ADD COLUMN IF NOT EXISTS hold_reason public.job_hold_reason,
  ADD COLUMN IF NOT EXISTS ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS location_type public.job_location_type NOT NULL DEFAULT 'shop',
  ADD COLUMN IF NOT EXISTS address jsonb,
  ADD COLUMN IF NOT EXISTS travel_fee_cents integer,
  ADD COLUMN IF NOT EXISTS access_notes jsonb,        -- {water, power, gate, parking}
  ADD COLUMN IF NOT EXISTS weather_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS quoted_amount_cents integer,
  ADD COLUMN IF NOT EXISTS payment_status public.job_payment_status NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS photos_before text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS photos_after text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS key_tag text,
  ADD COLUMN IF NOT EXISTS internal_note text;

UPDATE public.appointments
SET status = CASE
  WHEN confirmed_at IS NOT NULL THEN 'confirmed'::public.job_status
  ELSE 'booked'
END
WHERE status IS NULL;

UPDATE public.appointments a
SET customer_id = l.customer_id
FROM public.leads l
WHERE a.customer_id IS NULL
  AND a.lead_id = l.id
  AND l.customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_shop_status_idx
  ON public.appointments (shop_id, status);
CREATE INDEX IF NOT EXISTS appointments_customer_id_idx
  ON public.appointments (customer_id);

-- -----------------------------------------------------------------------------
-- services — size-class pricing (spec §5.15/§8). price_cents stays as the
-- fallback; resolution order (size-class price → price_cents) lives in ONE
-- shared module in the code phase, read by quotes, the voice agent, and
-- Whisper grounding alike.
-- -----------------------------------------------------------------------------
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS base_price_by_size jsonb,      -- {sedan: cents, truck_suv: cents, ...}
  ADD COLUMN IF NOT EXISTS duration_by_size jsonb,        -- {sedan: minutes, ...}
  ADD COLUMN IF NOT EXISTS condition_multipliers jsonb,   -- [{key, label, multiplier}]
  ADD COLUMN IF NOT EXISTS is_addon boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS addon_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mobile_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- -----------------------------------------------------------------------------
-- automations + automation_runs — the curated catalog (spec §15/C5). No
-- builder: catalog_key identifies a pre-built automation; owners toggle and
-- pick a mode. Money/calendar entries can never be autopilot — enforced in
-- isAutonomyAllowed() and its locking tests (code phase), not here.
-- automation_runs is append-only by convention (compensating rows, like
-- usage_events).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  catalog_key text NOT NULL,               -- new_lead_instant | missed_call_textback | quote_followup | lead_revival | appt_confirmation | appt_reminder | job_completed | review_request
  enabled boolean NOT NULL DEFAULT false,
  mode public.automation_mode NOT NULL DEFAULT 'approval',
  template_overrides jsonb NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}',      -- delays, thresholds
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, catalog_key)
);

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automations_tenant_isolation ON public.automations;
CREATE POLICY automations_tenant_isolation ON public.automations
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

CREATE TABLE IF NOT EXISTS public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES public.automations (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads (id) ON DELETE SET NULL,
  trigger_ref text,
  status public.automation_run_status NOT NULL DEFAULT 'staged',
  pending_action_id uuid REFERENCES public.pending_actions (id) ON DELETE SET NULL,
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_runs_shop_idx
  ON public.automation_runs (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_automation_idx
  ON public.automation_runs (automation_id, created_at DESC);

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_runs_tenant_isolation ON public.automation_runs;
CREATE POLICY automation_runs_tenant_isolation ON public.automation_runs
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
