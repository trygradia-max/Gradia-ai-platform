-- 20260618130000_crm_specialist_metrics.sql
-- CRM Specialist Agent framework: Found Money Ledger + Shadow Mode + lead revival
-- + no-show escalation ladder. PURELY ADDITIVE — does not touch pending_actions or
-- the ALWAYS_HITL calendar floor (book/reschedule/cancel remain human-approved).

-- 1. Shadow Mode flag on shops -------------------------------------------------
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS simulation_mode boolean NOT NULL DEFAULT false;

-- 2. Found Money Ledger (period snapshot, append/upsert per ROI receipt run) ----
CREATE TABLE IF NOT EXISTS public.shop_metrics (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                   uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  period_start              timestamptz NOT NULL,
  period_end                timestamptz NOT NULL,
  attributed_revenue_cents  bigint  NOT NULL DEFAULT 0,
  recovered_leads_count     integer NOT NULL DEFAULT 0,
  leads_count               integer NOT NULL DEFAULT 0,
  messages_count            integer NOT NULL DEFAULT 0,
  bookings_count            integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, period_start, period_end)   -- lets the cron ON CONFLICT upsert (idempotent)
);

CREATE INDEX IF NOT EXISTS shop_metrics_shop_period_idx
  ON public.shop_metrics (shop_id, period_start DESC);

ALTER TABLE public.shop_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shop_metrics_tenant_isolation ON public.shop_metrics;
CREATE POLICY shop_metrics_tenant_isolation ON public.shop_metrics
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- 3. Lead revival lifecycle (orthogonal to leads.status) -----------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_lifecycle') THEN
    CREATE TYPE public.lead_lifecycle AS ENUM (
      'unresponsive_stale', 'revival_contacted', 'recovered'
    );
  END IF;
END$$;

-- nullable: NULL = lead not in the revival funnel
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lifecycle_status public.lead_lifecycle;

CREATE INDEX IF NOT EXISTS leads_lifecycle_idx
  ON public.leads (shop_id, lifecycle_status)
  WHERE lifecycle_status IS NOT NULL;

-- 4. No-show escalation ladder -------------------------------------------------
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS escalation_level smallint NOT NULL DEFAULT 0;
