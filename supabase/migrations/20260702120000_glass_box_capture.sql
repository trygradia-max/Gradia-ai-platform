-- Glass Box data capture (redesign spec §8-A6). Two additive tables; no
-- existing table or behavior changes. Idempotent.
--
--   call_records — the per-call artifact Vapi already sends in its
--   end-of-call report but that was previously dropped after metering
--   (summary, duration, vendor cost, ended reason, recording URL). One
--   row per call, upserted on (shop_id, vapi_call_id) so webhook
--   retries stay idempotent. Metering still lives on usage_events —
--   vendor_cost here is the raw Vapi-reported figure for the record
--   page, NOT a billing input.
--
--   action_decisions — the "because" line: WHY an action was staged,
--   written best-effort at staging time (agent-runtime / vapi-tools).
--   `because` is one plain-English sentence citing the rule/data that
--   triggered the action; `inputs` holds the observable facts behind
--   it. The Glass Box UI renders a decision line ONLY where a row
--   exists — decisions are recorded, never reconstructed or invented.
--
-- Capture is best-effort by contract: the writers swallow their own
-- failures, so call handling and billing can never break on capture.

CREATE TABLE IF NOT EXISTS public.call_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,
  vapi_call_id text NOT NULL,
  summary text,
  ended_reason text,
  recording_url text,
  duration_seconds integer,
  vendor_cost numeric,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, vapi_call_id)
);

CREATE INDEX IF NOT EXISTS call_records_shop_id_idx
  ON public.call_records (shop_id, created_at DESC);

ALTER TABLE public.call_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_records_tenant_isolation ON public.call_records;
CREATE POLICY call_records_tenant_isolation ON public.call_records
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

CREATE TABLE IF NOT EXISTS public.action_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  pending_action_id uuid NOT NULL REFERENCES public.pending_actions (id) ON DELETE CASCADE,
  source text NOT NULL,
  because text NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pending_action_id)
);

CREATE INDEX IF NOT EXISTS action_decisions_shop_id_idx
  ON public.action_decisions (shop_id, created_at DESC);

ALTER TABLE public.action_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS action_decisions_tenant_isolation ON public.action_decisions;
CREATE POLICY action_decisions_tenant_isolation ON public.action_decisions
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
