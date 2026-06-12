-- White-label telephony foundation (TELEPHONY_VOICE_BUILDER_SPEC Phase 1).
--
-- Three concerns:
--   1. pricing_config — admin-editable retail/wholesale prices. Margin lives
--      in config, never in code. Server-only (RLS on, no user policy; the
--      service role bypasses RLS).
--   2. usage_events grows margin columns + telephony event kinds. The table
--      stays APPEND-ONLY — corrections are compensating entries. `credits`
--      remains the cap currency (1 credit ≈ 1¢ retail); wholesale_cost /
--      retail_cost (cents) make margin computable per event, and vendor_ref
--      ties each row to a Twilio/Vapi record for nightly reconciliation.
--   3. shops grow ISV-model columns: one Twilio subaccount per shop (created
--      on FIRST NUMBER PURCHASE, not signup) and an A2P 10DLC status gate —
--      outbound SMS on a Gradia-provisioned number is blocked in code until
--      a2p_status = 'approved'. Existing BYO/pilot shops are unaffected
--      (their creds columns stay; a2p_status only gates subaccount numbers).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.pricing_config (
  key text PRIMARY KEY,
  wholesale_cents numeric NOT NULL DEFAULT 0,
  retail_cents numeric NOT NULL DEFAULT 0,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pricing_config ENABLE ROW LEVEL SECURITY;
-- No user-facing policy on purpose: prices are read server-side (service
-- role) and edited by admins in the Supabase dashboard for v1.

-- Documented launch defaults (spec §1.4), plain cents (numeric allows
-- sub-cent wholesale). Tunable in the dashboard; ON CONFLICT keeps re-runs
-- from clobbering admin edits.
INSERT INTO public.pricing_config (key, wholesale_cents, retail_cents, note) VALUES
  ('number_monthly', 115,  250, 'Twilio local number ~$1.15/mo; Gradia retail $2.50/mo'),
  ('voice_minute',   13,   15,  'Bundled Twilio + Vapi + model cost per minute ~13¢; retail 15¢'),
  ('sms_segment',    0.79, 2,   'Twilio outbound segment ~0.79¢; retail 2¢')
ON CONFLICT (key) DO NOTHING;

-- usage_events: margin + reconciliation columns, new telephony kinds.
ALTER TABLE public.usage_events
  ADD COLUMN IF NOT EXISTS wholesale_cost numeric,
  ADD COLUMN IF NOT EXISTS retail_cost numeric,
  ADD COLUMN IF NOT EXISTS vendor_ref text;

ALTER TABLE public.usage_events
  DROP CONSTRAINT IF EXISTS usage_events_kind_check;
ALTER TABLE public.usage_events
  ADD CONSTRAINT usage_events_kind_check
  CHECK (kind IN ('agent_run', 'message', 'voice_minute', 'sms_segment', 'number_monthly'));

CREATE INDEX IF NOT EXISTS usage_events_vendor_ref_idx
  ON public.usage_events (vendor_ref)
  WHERE vendor_ref IS NOT NULL;

-- shops: ISV subaccount + provisioned number + A2P gate.
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS twilio_subaccount_sid text,
  ADD COLUMN IF NOT EXISTS twilio_subaccount_token_enc text,
  ADD COLUMN IF NOT EXISTS gradia_number_e164 text,
  ADD COLUMN IF NOT EXISTS gradia_number_sid text,
  ADD COLUMN IF NOT EXISTS a2p_status text NOT NULL DEFAULT 'unregistered'
    CHECK (a2p_status IN ('unregistered', 'pending', 'approved', 'rejected'));
