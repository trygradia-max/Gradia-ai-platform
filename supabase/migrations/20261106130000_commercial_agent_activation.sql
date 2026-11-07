BEGIN;
-- Commercial Billing PR C (review fix): atomic, owner-verified agent activation.
--
-- The previous action read the enabled-agent count in one request and wrote
-- `custom_agents.enabled` in another, so two concurrent activations could both
-- observe one active agent and both enable (three active). This moves the FINAL
-- entitlement decision and the activation write into one transaction that:
--   1. requires the service role AND names a live active OWNER of the exact shop,
--   2. locks the target agent row, then the shop's billing account row
--      (always in that order, so activations serialize per shop without deadlock),
--   3. treats an already-active agent as an idempotent no-op,
--   4. counts active agents under that lock and enforces Founder Pilot's maximum
--      of two (an application-supplied count is never an input),
--   5. rechecks the exact reviewed active subscription evidence and catalog,
--   6. enables ONLY the named agent, only if it belongs to that shop.
-- Disabling is untouched and never requires billing. No existing row is rewritten.
--
-- A guard trigger then makes this function the only way to turn an agent ON, so
-- the owner's RLS-bound direct UPDATE can no longer bypass it. Service-role
-- fixtures and operators are unaffected (they already hold full authority).


CREATE FUNCTION public.custom_agents_activation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.enabled IS TRUE
     AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM TRUE)
     AND coalesce(auth.role(), '') <> 'service_role'
     AND coalesce(current_setting('gradia.agent_activation', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'Agents are turned on through the activation boundary only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER custom_agents_activation_guard
  BEFORE INSERT OR UPDATE OF enabled ON public.custom_agents
  FOR EACH ROW EXECUTE FUNCTION public.custom_agents_activation_guard();

-- Result: {outcome, code, active_count}
--   outcome: activated | already_active | blocked
--   code (blocked): agent_not_found | active_agent_limit_reached | catalog_mismatch
--                   | billing_not_active
-- Failure codes: 42501 authority, 22023 invalid input.
CREATE FUNCTION public.commercial_agent_activate(p_shop uuid, p_actor uuid, p_agent uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c_catalog constant text := '2026-11-03.v1';
  c_plan constant text := 'founder-pilot';
  c_lookup constant text := 'gradia_founder_pilot_2026_11_monthly';
  c_max constant integer := 2;
  v_enabled boolean;
  acct public.commercial_billing_accounts;
  ev public.commercial_subscription_evidence;
  v_count integer;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_shop IS NULL OR p_actor IS NULL OR p_agent IS NULL THEN
    RAISE EXCEPTION 'shop, actor and agent are required' USING ERRCODE='22023';
  END IF;
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner of this workspace required' USING ERRCODE='42501';
  END IF;

  -- Tenant-bound target, locked. A foreign or unknown id is simply not found.
  SELECT a.enabled INTO v_enabled
    FROM public.custom_agents a
   WHERE a.id = p_agent AND a.shop_id = p_shop
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'agent_not_found', 'active_count', NULL);
  END IF;
  IF v_enabled THEN
    RETURN jsonb_build_object('outcome', 'already_active', 'code', NULL, 'active_count', NULL);
  END IF;

  -- Serialize per shop on the single billing account row.
  BEGIN
    acct := public.commercial_billing_lock(p_shop, p_actor, c_catalog, c_plan);
  EXCEPTION WHEN SQLSTATE 'CB409' THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'catalog_mismatch', 'active_count', NULL);
  END;

  SELECT count(*) INTO v_count FROM public.custom_agents WHERE shop_id = p_shop AND enabled;
  IF v_count >= c_max THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'active_agent_limit_reached', 'active_count', v_count);
  END IF;

  IF acct.state <> 'active' OR acct.provider_mode <> 'test' OR acct.current_evidence_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'billing_not_active', 'active_count', v_count);
  END IF;
  SELECT * INTO ev FROM public.commercial_subscription_evidence
   WHERE shop_id = p_shop AND id = acct.current_evidence_id;
  IF NOT FOUND
     OR ev.derived_state <> 'active' OR ev.provider_status <> 'active' OR ev.livemode IS NOT FALSE
     OR ev.catalog_version <> c_catalog OR ev.plan_key <> c_plan OR ev.price_lookup_key <> c_lookup
     OR ev.evidence_source NOT IN ('signed_webhook', 'reviewed_reconciliation')
  THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'billing_not_active', 'active_count', v_count);
  END IF;

  PERFORM set_config('gradia.agent_activation', 'on', true);
  UPDATE public.custom_agents SET enabled = true WHERE id = p_agent AND shop_id = p_shop;
  PERFORM set_config('gradia.agent_activation', 'off', true);

  RETURN jsonb_build_object('outcome', 'activated', 'code', NULL, 'active_count', v_count + 1);
END $$;

REVOKE ALL ON FUNCTION public.custom_agents_activation_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commercial_agent_activate(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commercial_agent_activate(uuid, uuid, uuid) TO service_role;

COMMIT;
