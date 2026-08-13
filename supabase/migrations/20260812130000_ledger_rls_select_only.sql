-- P0-005 — Ledger immutability from the browser session (D-024, scoped).
--
-- Audit doc 05 §Schema weaknesses #4: usage_events, payments, shop_metrics
-- carried FOR ALL tenant policies — an owner session could INSERT/UPDATE/
-- DELETE its own billing/revenue rows via PostgREST (e.g. insert a
-- negative-credit usage row to inflate its balance). All legitimate writes
-- are service-role (verified by grep during P0-005; the two session-client
-- writers found — recordUsage callers and the Stripe payments backfill —
-- were moved to service-role in the same change, see ADR-001).
--
-- This flips the three ledgers to the credit_grants pattern: owner sessions
-- keep SELECT (billing page, ROI receipt, BI reads are unchanged); writes
-- are service-role only (service role bypasses RLS entirely).
--
-- Idempotent. Rollback: supabase/rollbacks/20260812_p0_005_down.sql
-- (restores the FOR ALL policies; kept unapplied).

-- usage_events ----------------------------------------------------------
DROP POLICY IF EXISTS usage_events_tenant_isolation ON public.usage_events;
DROP POLICY IF EXISTS usage_events_tenant_read ON public.usage_events;
CREATE POLICY usage_events_tenant_read ON public.usage_events
  FOR SELECT USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- payments --------------------------------------------------------------
DROP POLICY IF EXISTS payments_tenant_isolation ON public.payments;
DROP POLICY IF EXISTS payments_tenant_read ON public.payments;
CREATE POLICY payments_tenant_read ON public.payments
  FOR SELECT USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- shop_metrics -----------------------------------------------------------
DROP POLICY IF EXISTS shop_metrics_tenant_isolation ON public.shop_metrics;
DROP POLICY IF EXISTS shop_metrics_tenant_read ON public.shop_metrics;
CREATE POLICY shop_metrics_tenant_read ON public.shop_metrics
  FOR SELECT USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
