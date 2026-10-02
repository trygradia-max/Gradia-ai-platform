BEGIN;
-- Activation is explicit, owner-only and revision-bound. Existing drafts stay inert.
CREATE TABLE public.control_policy_active (
 shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
 revision integer NOT NULL,
 activated_by uuid NOT NULL REFERENCES auth.users(id),
 activated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(shop_id,revision) REFERENCES public.control_policy_history(shop_id,revision)
);
CREATE TABLE public.control_policy_activations (
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 revision integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,revision),
 FOREIGN KEY(shop_id,revision) REFERENCES public.control_policy_history(shop_id,revision)
);
CREATE TABLE public.control_execution_decisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 action_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 location_id uuid NOT NULL,
 action_type text NOT NULL,
 policy_revision integer,
 staged_revision integer,
 payload_hash text NOT NULL,
 context text NOT NULL CHECK(context IN ('hitl','automatic')),
 mode text NOT NULL CHECK(mode IN ('off','read','suggest','approval','autonomous')),
 allowed boolean NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(shop_id,action_id) REFERENCES public.pending_actions(shop_id,id) ON DELETE CASCADE,
 FOREIGN KEY(shop_id,location_id) REFERENCES public.shop_locations(shop_id,id),
 FOREIGN KEY(shop_id,policy_revision) REFERENCES public.control_policy_history(shop_id,revision),
 FOREIGN KEY(shop_id,staged_revision) REFERENCES public.control_policy_history(shop_id,revision)
);
ALTER TABLE public.pending_actions ADD COLUMN control_staged_revision integer;
ALTER TABLE public.control_policy_active ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.control_policy_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.control_execution_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.control_policy_active,public.control_policy_activations,public.control_execution_decisions FROM anon,authenticated,service_role;
GRANT SELECT ON public.control_policy_active,public.control_policy_activations,public.control_execution_decisions TO authenticated,service_role;
-- Published snapshots must not be rewritten by background service clients.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.control_policy_history FROM service_role;
CREATE POLICY control_active_owner ON public.control_policy_active FOR SELECT TO authenticated USING(public.team_is_owner(shop_id));
CREATE POLICY control_activations_owner ON public.control_policy_activations FOR SELECT TO authenticated USING(public.team_is_owner(shop_id));
CREATE POLICY control_decisions_owner ON public.control_execution_decisions FOR SELECT TO authenticated USING(public.team_is_owner(shop_id));

CREATE FUNCTION public.activate_control_policy(p_shop uuid,p_revision integer,p_expected_active integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE draft public.control_policy_drafts; previous integer;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_is_owner(p_shop) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 SELECT * INTO draft FROM public.control_policy_drafts WHERE shop_id=p_shop FOR UPDATE;
 SELECT revision INTO previous FROM public.control_policy_active WHERE shop_id=p_shop;
 IF draft.revision IS DISTINCT FROM p_revision OR previous IS DISTINCT FROM p_expected_active THEN
  RAISE EXCEPTION 'Policy revision changed; reload before activating' USING ERRCODE='PT409';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_policy_history h WHERE h.shop_id=p_shop AND h.revision=p_revision AND h.definition=draft.definition AND h.location_id=draft.location_id) THEN RAISE EXCEPTION 'Draft snapshot mismatch' USING ERRCODE='22023'; END IF;
 IF NOT public.control_validate_draft(draft.definition) THEN RAISE EXCEPTION 'Invalid policy' USING ERRCODE='22023'; END IF;
 IF previous=p_revision THEN RETURN previous; END IF;
 INSERT INTO public.control_policy_activations(shop_id,revision,actor_id) VALUES(p_shop,p_revision,auth.uid());
 INSERT INTO public.control_policy_active(shop_id,revision,activated_by) VALUES(p_shop,p_revision,auth.uid())
 ON CONFLICT(shop_id) DO UPDATE SET revision=EXCLUDED.revision,activated_by=EXCLUDED.activated_by,activated_at=now();
 RETURN p_revision;
END $$;

-- The current pending-action envelope does not carry trusted granular purpose/risk
-- facts. Intersect every possible communication purpose and unknown risk/exception
-- ceiling, never infer a permissive classification from model-authored payload.
-- This is the bounded SQL execution adapter for the existing pure policy contract.
CREATE FUNCTION public.control_pending_mode(p_definition jsonb,p_type text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE operations text[]; connector text; op text; selected text; cap text; ceiling text;
 rank integer:=5; r integer; modes text[]:=ARRAY['off','read','suggest','approval','autonomous'];
BEGIN
 IF NOT public.control_validate_draft(p_definition) THEN RETURN 'off'; END IF;
 IF p_definition->'enabled'<>'true'::jsonb THEN RETURN 'off'; END IF;
 CASE p_type
 WHEN 'create_lead' THEN connector:='crm';operations:=ARRAY['intake.capture'];
 WHEN 'add_note' THEN connector:='crm';operations:=ARRAY['crm.edit'];
 WHEN 'send_sms' THEN connector:='sms';operations:=ARRAY['sms.reply','sms.qualify','sms.nurture','sms.confirm','sms.remind','sms.followup'];
 WHEN 'send_email' THEN connector:='email';operations:=ARRAY['email.reply','email.qualify','email.nurture','email.confirm','email.remind','email.followup'];
 WHEN 'book_appointment' THEN connector:='calendar';operations:=ARRAY['booking.create'];
 WHEN 'reschedule_appointment' THEN connector:='calendar';operations:=ARRAY['booking.reschedule'];
 WHEN 'cancel_appointment' THEN connector:='calendar';operations:=ARRAY['booking.cancel'];
 WHEN 'create_quote' THEN connector:='crm';operations:=ARRAY['quote.send','quote.discount'];
 ELSE RETURN 'off'; END CASE;
 FOREACH op IN ARRAY operations LOOP
  selected:=coalesce(p_definition->'actionGrants'->>op,p_definition->>'workspaceDefault','approval');
  -- Workspace-wide autonomy alone never grants a customer action.
  IF selected='autonomous' AND (p_definition->'actionGrants'->>op) IS DISTINCT FROM 'autonomous' THEN selected:='approval'; END IF;
  rank:=least(rank,array_position(modes,selected));
 END LOOP;
 FOREACH ceiling IN ARRAY ARRAY[p_definition->>'workspaceCeiling',p_definition->>'locationCeiling',p_definition->'connectorCeilings'->>connector,p_definition->'roleCeilings'->>'owner'] LOOP
  IF ceiling IS NOT NULL THEN rank:=least(rank,array_position(modes,ceiling)); END IF;
 END LOOP;
 FOR cap IN SELECT value #>> '{}' FROM jsonb_each(p_definition->'riskCeilings') UNION ALL SELECT value #>> '{}' FROM jsonb_each(p_definition->'exceptionCeilings') LOOP
  IF cap IS NOT NULL THEN r:=array_position(modes,cap);rank:=least(rank,r); END IF;
 END LOOP;
 -- Calendar/money floors and unverified-intake setup cannot be loosened here.
 IF p_type IN ('book_appointment','reschedule_appointment','cancel_appointment','create_quote','create_lead') THEN rank:=least(rank,4); END IF;
 RETURN coalesce(modes[rank],'off');
END $$;

CREATE FUNCTION public.control_guard_staging() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE definition jsonb; revision integer; effective text;
BEGIN
 -- Shop lock is shared with activation and membership changes. No stale publication.
 PERFORM 1 FROM public.shops WHERE id=NEW.shop_id FOR UPDATE;
 SELECT a.revision,h.definition INTO revision,definition FROM public.control_policy_active a
 JOIN public.control_policy_history h ON h.shop_id=a.shop_id AND h.revision=a.revision WHERE a.shop_id=NEW.shop_id;
 IF revision IS NOT NULL THEN
  effective:=public.control_pending_mode(definition,NEW.action_type::text);
  IF effective IN ('off','read','suggest') THEN RAISE EXCEPTION 'Current policy does not permit executable staging' USING ERRCODE='42501'; END IF;
 END IF;
 NEW.control_staged_revision:=revision;
 RETURN NEW;
END $$;
CREATE TRIGGER control_guard_staging BEFORE INSERT ON public.pending_actions FOR EACH ROW EXECUTE FUNCTION public.control_guard_staging();

CREATE FUNCTION public.control_preserve_staged_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.control_staged_revision IS DISTINCT FROM OLD.control_staged_revision THEN
  RAISE EXCEPTION 'Staged policy evidence is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_preserve_staged_revision BEFORE UPDATE OF control_staged_revision ON public.pending_actions FOR EACH ROW EXECUTE FUNCTION public.control_preserve_staged_revision();
REVOKE ALL ON FUNCTION public.control_preserve_staged_revision() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.claim_control_action(p_shop uuid,p_action uuid,p_actor uuid,p_context text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE shop public.shops; action public.pending_actions; revision integer; definition jsonb; location uuid;
 effective text:='approval'; reason text; allowed boolean:=false;
BEGIN
 IF p_context NOT IN ('hitl','automatic') OR p_context IS NULL THEN RETURN jsonb_build_object('denied','invalid_context'); END IF;
 SELECT * INTO shop FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF shop.id IS NULL OR p_actor IS DISTINCT FROM shop.owner_id
 OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=p_actor AND active AND role='owner')
 OR (auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS DISTINCT FROM p_actor OR p_context<>'hitl')) THEN
  RETURN jsonb_build_object('denied','actor_not_authorized');
 END IF;
 SELECT id INTO location FROM public.shop_locations WHERE shop_id=p_shop;
 IF location IS NULL THEN RETURN jsonb_build_object('denied','location_unavailable'); END IF;
 SELECT * INTO action FROM public.pending_actions WHERE id=p_action AND shop_id=p_shop FOR UPDATE;
 IF action.id IS NULL THEN RETURN jsonb_build_object('already_decided',true); END IF;
 IF action.status::text NOT IN ('pending','edit_requested') THEN RETURN jsonb_build_object('already_decided',true); END IF;
 SELECT a.revision,h.definition INTO revision,definition FROM public.control_policy_active a
 JOIN public.control_policy_history h ON h.shop_id=a.shop_id AND h.revision=a.revision WHERE a.shop_id=p_shop;
 IF revision IS NOT NULL THEN effective:=public.control_pending_mode(definition,action.action_type::text); END IF;
 -- Unknown actions fail closed even before activation.
 IF action.action_type::text NOT IN ('create_lead','add_note','send_sms','send_email','book_appointment','reschedule_appointment','cancel_appointment','create_quote') THEN effective:='off'; END IF;
 reason:=CASE
  WHEN effective IN ('off','read','suggest') THEN 'execution_not_permitted'
  WHEN p_context='automatic' AND revision IS NULL THEN 'explicit_activation_required'
  WHEN p_context='automatic' AND effective<>'autonomous' THEN 'human_approval_required'
  WHEN p_context='automatic' AND (shop.plan::text IS DISTINCT FROM 'active' OR shop.voice_addon IS DISTINCT FROM true) THEN 'autonomy_entitlement_required'
  ELSE 'current_policy_authorized' END;
 allowed:=reason='current_policy_authorized';
 INSERT INTO public.control_execution_decisions(shop_id,action_id,actor_id,location_id,action_type,policy_revision,staged_revision,payload_hash,context,mode,allowed,reason)
 VALUES(p_shop,p_action,p_actor,location,action.action_type::text,revision,action.control_staged_revision,encode(sha256(convert_to(jsonb_build_object('shop',p_shop,'location',location,'action',p_action,'type',action.action_type,'payload',action.payload)::text,'UTF8')),'hex'),p_context,effective,allowed,reason);
 IF NOT allowed THEN RETURN jsonb_build_object('denied',reason); END IF;
 UPDATE public.pending_actions SET status='approved',decided_at=now(),decided_by_user=p_actor WHERE id=p_action AND shop_id=p_shop;
 RETURN jsonb_build_object('id',action.id,'shop_id',action.shop_id,'action_type',action.action_type,'payload',action.payload);
END $$;
REVOKE ALL ON FUNCTION public.activate_control_policy(uuid,integer,integer),public.control_pending_mode(jsonb,text),public.control_guard_staging(),public.claim_control_action(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.activate_control_policy(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_control_action(uuid,uuid,uuid,text) TO authenticated,service_role;
-- Pure adapter is safe to inspect; no database access or authority is granted.
GRANT EXECUTE ON FUNCTION public.control_pending_mode(jsonb,text) TO authenticated,service_role;
COMMIT;
