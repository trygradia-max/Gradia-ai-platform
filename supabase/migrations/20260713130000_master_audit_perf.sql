-- 2026-07-13 master audit — performance follow-ups. All additive.
--
-- 1. revenue_summary(): aggregate paid-invoice revenue in Postgres instead
--    of shipping every payments row to the app (lib/data/revenue.ts was an
--    unbounded scan). SECURITY INVOKER — RLS on payments still applies when
--    called from a user session; the explicit p_shop_id keeps service-role
--    callers scoped too.
-- 2. Composite index on interactions for the three hot readers that filter
--    (shop_id, customer_id) and sort by occurred_at DESC.
-- 3. Expression indexes for JSONB-path filters that were sequential scans:
--    call-record lookups by vapi_call_id and pipeline's pending_actions
--    match by payload customer_id.

CREATE OR REPLACE FUNCTION public.revenue_summary(p_shop_id uuid)
RETURNS TABLE (bucket text, cents bigint, invoice_count bigint)
LANGUAGE sql
STABLE
AS $$
  WITH nets AS (
    SELECT
      GREATEST(0, amount_cents - COALESCE(refunded_amount_cents, 0)) AS net,
      paid_at
    FROM public.payments
    WHERE shop_id = p_shop_id
      AND amount_cents > 0
  )
  SELECT 'week'::text, COALESCE(SUM(net), 0)::bigint, COUNT(*)::bigint
    FROM nets WHERE paid_at >= now() - interval '7 days'
  UNION ALL
  SELECT 'month', COALESCE(SUM(net), 0)::bigint, COUNT(*)::bigint
    FROM nets WHERE paid_at >= now() - interval '30 days'
  UNION ALL
  SELECT 'all_time', COALESCE(SUM(net), 0)::bigint, COUNT(*)::bigint
    FROM nets;
$$;

GRANT EXECUTE ON FUNCTION public.revenue_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_summary(uuid) TO service_role;

-- Hot readers: lib/data/customers.ts lastInteractionByCustomer + customer
-- detail timeline + MCP get_customer_timeline all filter shop+customer and
-- sort newest-first.
CREATE INDEX IF NOT EXISTS interactions_shop_customer_occurred_idx
  ON public.interactions (shop_id, customer_id, occurred_at DESC);

-- lib/data/call-records.ts:85 — interactions.metadata->>'vapi_call_id'.
CREATE INDEX IF NOT EXISTS interactions_shop_vapi_call_idx
  ON public.interactions (shop_id, (metadata ->> 'vapi_call_id'))
  WHERE metadata ? 'vapi_call_id';

-- lib/data/call-records.ts:92 — pending_actions.payload->>'vapi_call_id'.
CREATE INDEX IF NOT EXISTS pending_actions_shop_vapi_call_idx
  ON public.pending_actions (shop_id, (payload ->> 'vapi_call_id'))
  WHERE payload ? 'vapi_call_id';

-- lib/data/pipeline.ts:84-89 — board-load match of staged actions to leads
-- by payload customer_id.
CREATE INDEX IF NOT EXISTS pending_actions_shop_payload_customer_idx
  ON public.pending_actions (shop_id, (payload ->> 'customer_id'))
  WHERE payload ? 'customer_id';

-- 4. Meter the inbound classify+draft pipeline (audit P1: every inbound
--    SMS/email runs Haiku classification + a drafted reply + a KB search
--    with NO usage_events row — per-message LLM cost invisible to billing
--    and the margin report). Cost-visibility SKU: wholesale carries the
--    real vendor cost; retail 0 / credits 0 — shops are NOT charged for
--    receiving messages. Charging for it is a founder pricing decision
--    (GRADIA_PRICING.md owns that); this row just makes the cost real.
ALTER TABLE public.usage_events
  DROP CONSTRAINT IF EXISTS usage_events_kind_check;
ALTER TABLE public.usage_events
  ADD CONSTRAINT usage_events_kind_check
  CHECK (kind IN (
    'agent_run', 'message', 'voice_minute', 'sms_segment', 'number_monthly',
    'email_send', 'outreach_draft', 'bi_answer', 'whisper_note',
    'agentic_plan', 'inbound_classify'
  ));

INSERT INTO public.pricing_config (key, wholesale_cents, retail_cents, note) VALUES
  ('inbound_classify', 0.2, 0,
   '2026-07-13 audit: Haiku classify + auto-draft per inbound msg. Retail 0 by design — cost visibility only; repricing is a founder decision.')
ON CONFLICT (key) DO NOTHING;
