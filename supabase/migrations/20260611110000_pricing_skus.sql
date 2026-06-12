-- Locked pricing & SKUs (GRADIA_PRICING.md, locked 2026-06-11).
--
-- Three concerns:
--   1. The credit MENU: per-action kinds with locked retail prices.
--      1 credit = 1¢ retail. Plumbing the owner didn't initiate
--      (classification, approvals, CRM/calendar/KB ops) is NEVER metered.
--   2. Meter separation: voice minutes are their own meter — voice_minute
--      rows stop carrying credits (the webhook writes credits=0) so voice
--      can never drain message credits and vice versa.
--   3. Allowance machinery: `credit_grants` records pack purchases and
--      monthly rollover. Spend caps derive from plan allowance + grants,
--      not from the owner-set credit_limit (that column is retained for
--      the future auto-top-up ceiling, no longer the fail-closed cap).
--
-- The locked prices below intentionally OVERWRITE earlier seeds
-- (sms_segment 2→4, voice_minute 13/15→12/25): the pricing doc supersedes.
-- Future tuning happens in the dashboard; re-running this migration
-- re-asserts the locked 2026-06-11 baseline. Idempotent.

-- 1. New metered kinds --------------------------------------------------
ALTER TABLE public.usage_events
  DROP CONSTRAINT IF EXISTS usage_events_kind_check;
ALTER TABLE public.usage_events
  ADD CONSTRAINT usage_events_kind_check
  CHECK (kind IN (
    'agent_run', 'message', 'voice_minute', 'sms_segment', 'number_monthly',
    'email_send', 'outreach_draft', 'bi_answer', 'whisper_note', 'agentic_plan'
  ));

-- 2. The locked credit menu (retail cents = credits; wholesale ≈ retail/3.3)
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

-- 3. Voice add-on state on the shop ------------------------------------
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS voice_addon boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_addon_ended_at timestamptz;

-- 4. Credit/minute grants (packs + rollover) ----------------------------
CREATE TABLE IF NOT EXISTS public.credit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('credit_pack', 'minute_pack', 'rollover')),
  credits integer NOT NULL DEFAULT 0,
  minutes integer NOT NULL DEFAULT 0,
  -- Stripe session/invoice id — the idempotency key for webhook retries.
  stripe_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_stripe_ref_key
  ON public.credit_grants (stripe_ref)
  WHERE stripe_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_grants_shop_period_idx
  ON public.credit_grants (shop_id, created_at DESC);

ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_grants_tenant_read ON public.credit_grants;
CREATE POLICY credit_grants_tenant_read ON public.credit_grants
  FOR SELECT USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
-- Writes are service-role only (webhook + rollover); no user policy.
