-- P0-005 DOWN migration — written per the ticket's rollback strategy,
-- deliberately KEPT UNAPPLIED (this directory is not read by the Supabase
-- CLI). Apply manually only if P0-005 must be reverted. Code paths degrade
-- gracefully without the constraints: 23505 handlers simply never fire, the
-- retained fast-path checks keep pre-P0-005 behavior, and the claim helper
-- is unused until P0-006/007 wire it. No data loss in either direction
-- (claim rows become inert; DROP TABLE below discards only claim
-- bookkeeping, never business data).

-- Reverse 20260812130000_ledger_rls_select_only.sql --------------------
DROP POLICY IF EXISTS usage_events_tenant_read ON public.usage_events;
CREATE POLICY usage_events_tenant_isolation ON public.usage_events
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS payments_tenant_read ON public.payments;
CREATE POLICY payments_tenant_isolation ON public.payments
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS shop_metrics_tenant_read ON public.shop_metrics;
CREATE POLICY shop_metrics_tenant_isolation ON public.shop_metrics
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- Reverse 20260812120000_webhook_idempotency.sql -----------------------
DROP FUNCTION IF EXISTS public.claim_provider_event(text, text, uuid, jsonb, integer, boolean);
DROP FUNCTION IF EXISTS public.complete_provider_event(text, text);
DROP FUNCTION IF EXISTS public.fail_provider_event(text, text, text);
DROP TABLE IF EXISTS public.provider_events;
DROP INDEX IF EXISTS public.automation_runs_trigger_ref_unique;
DROP INDEX IF EXISTS public.usage_events_vendor_ref_unique;
