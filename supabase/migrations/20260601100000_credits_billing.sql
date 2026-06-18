-- Credits + subscription paywall (MVP Phase 3).
--
-- Two concerns:
--   1. Subscription state for the $20/mo Gradia plan (distinct from the
--      hidden Stripe Connect flow that charges the detailer's customers).
--   2. A usage-credit meter so autopilot actions can't run away on cost.
--
-- `usage_events` is an append-only ledger; credits spent in the current
-- period are derived by summing it since `shops.credit_period_start`, so
-- there's no cached balance to drift. `credit_limit` is the owner-set cap
-- the runtime fails closed against.
--
-- Existing shops default to plan='active' (grandfathered) so flipping the
-- paywall flag on can never lock out the pilot. New-signup defaulting +
-- real Stripe wiring are go-live steps. Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'active'
    CHECK (plan IN ('free', 'active', 'past_due')),
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS credit_limit integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS credit_period_start timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('agent_run', 'message', 'voice_minute')),
  quantity integer NOT NULL DEFAULT 1,
  credits integer NOT NULL DEFAULT 0,
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_shop_period_idx
  ON public.usage_events (shop_id, created_at DESC);

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_events_tenant_isolation ON public.usage_events;
CREATE POLICY usage_events_tenant_isolation ON public.usage_events
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
