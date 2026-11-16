BEGIN;
-- Security audit run-1 (NEEDS-VALIDATION): a2p_registrations was owner-writable.
--
-- The original policy was FOR ALL ... WITH CHECK (owner), and authenticated held
-- table-wide write grants, so a signed-in owner could, through PostgREST, rewrite
-- status, every provider SID, the claim lease, evidence timestamps and attempt
-- counters on their own row, reset approved/suspended/pending to 'draft', delete
-- the row, or insert a fresh one. startA2pRegistration trusts that row (a 'draft'
-- is claimable and, with changed details, starts a fresh provider chain), so the
-- browser role could re-enter provider registration through trusted service code.
--
-- No browser or owner-session code writes this table (every writer uses the
-- service client; getA2pState only reads), so there is no owner-editable column
-- to preserve: `business` is also server-written, because pre-editing it would
-- steer the same-details resume / campaign-resubmit branches. The owner keeps
-- read access to their own row for the wizard.
--
-- Three layers, so one regression cannot reopen it:
--   1. RLS: owner SELECT only (no INSERT/UPDATE/DELETE policy).
--   2. Grants: INSERT/UPDATE/DELETE/TRUNCATE revoked from authenticated, anon.
--   3. Guard trigger: refuses any write by authenticated/anon (42501, DETAIL
--      server_written), so a later policy or grant mistake still fails closed.
-- service_role, SECURITY DEFINER functions, foreign-key cascades (run as the
-- table owner) and migrations are unaffected. No existing row is touched.

DROP POLICY IF EXISTS a2p_registrations_tenant_isolation ON public.a2p_registrations;
DROP POLICY IF EXISTS a2p_registrations_owner_select ON public.a2p_registrations;
CREATE POLICY a2p_registrations_owner_select ON public.a2p_registrations
  FOR SELECT TO authenticated
  USING (shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.a2p_registrations FROM anon, authenticated;
REVOKE ALL ON public.a2p_registrations FROM anon;

CREATE OR REPLACE FUNCTION public.a2p_registrations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Carrier registration is server-written'
      USING ERRCODE = '42501', DETAIL = 'server_written', HINT = 'a2p_registrations';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.a2p_registrations_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a2p_registrations_guard ON public.a2p_registrations;
CREATE TRIGGER a2p_registrations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.a2p_registrations
  FOR EACH ROW EXECUTE FUNCTION public.a2p_registrations_guard();
COMMIT;
