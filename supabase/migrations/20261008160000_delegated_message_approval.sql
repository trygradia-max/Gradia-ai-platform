BEGIN;
-- Delegated manager approval of queued customer messages (SMS and email) only.
-- An explicit owner grant is required. Bookings, quotes, captures, record edits and
-- identity resolution stay owner-only. Consent, STOP, DNC, quiet hours, proof and
-- channel readiness are still enforced by the existing executor at send time.
DO $$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['shop_memberships','shop_invitations'] LOOP
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target,target||'_capabilities_known');
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (capabilities <@ ARRAY[''crm.read'',''notes.write'',''jobs.progress'',''assignments.manage'',''delivery.reconcile'',''approvals.messages'']::text[])',target,target||'_capabilities_known');
  -- An approver must be able to read the customer and message being approved.
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (NOT (''approvals.messages''=ANY(capabilities)) OR ''crm.read''=ANY(capabilities))',target,target||'_message_approval_needs_read');
 END LOOP;
END $$;

-- Every earlier decision was made by, or automatically on behalf of, the owner.
ALTER TABLE public.control_execution_decisions ADD COLUMN actor_role text NOT NULL DEFAULT 'owner' CHECK (actor_role IN ('owner','manager'));
ALTER TABLE public.control_execution_decisions ALTER COLUMN actor_role DROP DEFAULT;

-- The exact content a reviewer saw. jsonb text output is canonical for equal values.
CREATE FUNCTION public.control_review_hash(p_payload jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')
$$;

-- Single claim body for owner, automatic and delegated callers. Not directly callable.
CREATE FUNCTION public.control_claim(p_shop uuid,p_action uuid,p_actor uuid,p_context text,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE shop public.shops; action public.pending_actions; revision integer; definition jsonb; location uuid;
 record_id uuid; effective text:='approval'; reason text; allowed boolean:=false; actor_role text; ceiling text;
 modes text[]:=ARRAY['off','read','suggest','approval','autonomous'];
BEGIN
 IF p_context NOT IN ('hitl','automatic') OR p_context IS NULL THEN RETURN jsonb_build_object('denied','invalid_context'); END IF;
 SELECT * INTO shop FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF shop.id IS NULL OR p_actor IS NULL THEN RETURN jsonb_build_object('denied','actor_not_authorized'); END IF;
 IF p_actor=shop.owner_id
  AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=p_actor AND active AND role='owner')
  AND (auth.role() IS NOT DISTINCT FROM 'service_role' OR (auth.uid() IS NOT DISTINCT FROM p_actor AND p_context='hitl')) THEN
  actor_role:='owner';
 -- A manager is authorized only by their own live session and both explicit grants.
 -- A service caller can never act as a manager, and a manager is never automatic.
 ELSIF p_expected IS NOT NULL AND auth.role() IS DISTINCT FROM 'service_role' AND auth.uid() IS NOT DISTINCT FROM p_actor AND p_context='hitl'
  AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=p_actor AND active AND role='manager'
   AND capabilities @> ARRAY['crm.read','approvals.messages']::text[]) THEN
  actor_role:='manager';
 ELSE
  RETURN jsonb_build_object('denied','actor_not_authorized');
 END IF;
 SELECT id INTO location FROM public.shop_locations WHERE shop_id=p_shop;
 IF location IS NULL THEN RETURN jsonb_build_object('denied','location_unavailable'); END IF;
 SELECT * INTO action FROM public.pending_actions WHERE id=p_action AND shop_id=p_shop FOR UPDATE;
 IF action.id IS NULL THEN RETURN jsonb_build_object('already_decided',true); END IF;
 IF action.status::text NOT IN ('pending','edit_requested') THEN RETURN jsonb_build_object('already_decided',true); END IF;
 -- A delegated approval is bound to the exact message reviewed. An owner edit in
 -- progress, or any change since the review, requires a fresh review. Actions a
 -- manager can never approve skip this and reach the audited refusal below.
 IF NOT (actor_role='manager' AND action.action_type::text NOT IN ('send_sms','send_email'))
  AND ((actor_role='manager' AND action.status::text<>'pending')
   OR (p_expected IS NOT NULL AND p_expected IS DISTINCT FROM public.control_review_hash(action.payload))) THEN
  RETURN jsonb_build_object('denied','review_changed');
 END IF;
 -- Token permission is required again at approval, including old queued MCP work.
 IF action.payload->>'source'='mcp' AND NOT EXISTS(SELECT 1 FROM public.mcp_tokens
  WHERE id=(action.payload->>'mcp_token_id')::uuid AND shop_id=p_shop AND revoked_at IS NULL
  AND public.mcp_proposal_capability(action.action_type::text)=ANY(capabilities) FOR SHARE) THEN
  RETURN jsonb_build_object('denied','mcp_capability_unavailable');
 END IF;
 SELECT a.revision,h.definition INTO revision,definition FROM public.control_policy_active a
 JOIN public.control_policy_history h ON h.shop_id=a.shop_id AND h.revision=a.revision WHERE a.shop_id=p_shop;
 IF revision IS NOT NULL THEN effective:=public.control_pending_mode(definition,action.action_type::text); END IF;
 -- The activated policy's manager ceiling can only tighten a delegated approval.
 IF actor_role='manager' AND revision IS NOT NULL THEN
  ceiling:=definition->'roleCeilings'->>'manager';
  IF ceiling IS NOT NULL THEN effective:=coalesce(modes[least(array_position(modes,effective),array_position(modes,ceiling))],'off'); END IF;
 END IF;
 -- Unknown actions fail closed even before activation.
 IF action.action_type::text NOT IN ('create_lead','add_note','send_sms','send_email','book_appointment','reschedule_appointment','cancel_appointment','create_quote','update_customer','resolve_customer','record_interaction') THEN effective:='off'; END IF;
 reason:=CASE
  WHEN actor_role='manager' AND action.action_type::text NOT IN ('send_sms','send_email') THEN 'owner_approval_required'
  WHEN effective IN ('off','read','suggest') THEN 'execution_not_permitted'
  WHEN p_context='automatic' AND revision IS NULL THEN 'explicit_activation_required'
  WHEN p_context='automatic' AND effective<>'autonomous' THEN 'human_approval_required'
  WHEN p_context='automatic' AND (shop.plan::text IS DISTINCT FROM 'active' OR shop.voice_addon IS DISTINCT FROM true) THEN 'autonomy_entitlement_required'
  ELSE 'current_policy_authorized' END;
 allowed:=reason='current_policy_authorized';
 INSERT INTO public.control_execution_decisions(shop_id,action_id,actor_id,actor_role,location_id,action_type,policy_revision,staged_revision,payload_hash,context,mode,allowed,reason)
 VALUES(p_shop,p_action,p_actor,actor_role,location,action.action_type::text,revision,action.control_staged_revision,encode(sha256(convert_to(jsonb_build_object('shop',p_shop,'location',location,'action',p_action,'type',action.action_type,'payload',action.payload)::text,'UTF8')),'hex'),p_context,effective,allowed,reason);
 IF NOT allowed THEN RETURN jsonb_build_object('denied',reason); END IF;
 IF action.action_type::text IN ('update_customer','resolve_customer','record_interaction') THEN
  record_id:=public.control_apply_record(p_shop,p_action,p_actor,action.action_type::text,action.payload);
 END IF;
 UPDATE public.pending_actions SET result_id=coalesce(record_id,result_id),status='approved',decided_at=now(),decided_by_user=p_actor WHERE id=p_action AND shop_id=p_shop;
 RETURN jsonb_build_object('id',action.id,'shop_id',action.shop_id,'action_type',action.action_type,'payload',action.payload,'result_id',record_id);
END $$;

-- Existing entry point: unchanged signature and grants. Carries no review binding,
-- so it can never authorize a manager.
CREATE OR REPLACE FUNCTION public.claim_control_action(p_shop uuid,p_action uuid,p_actor uuid,p_context text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT public.control_claim(p_shop,p_action,p_actor,p_context,NULL)
$$;

-- Session-only delegated entry point. The actor is always the signed-in caller.
CREATE FUNCTION public.claim_delegated_message(p_shop uuid,p_action uuid,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL OR p_expected IS NULL OR p_expected !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('denied','actor_not_authorized'); END IF;
 RETURN public.control_claim(p_shop,p_action,auth.uid(),'hitl',p_expected);
END $$;

CREATE FUNCTION public.message_approval_role(p_shop uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.role FROM public.shop_memberships m JOIN public.shops s ON s.id=m.shop_id
 WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
 AND ((m.role='owner' AND s.owner_id=m.user_id)
  OR (m.role='manager' AND m.capabilities @> ARRAY['crm.read','approvals.messages']::text[]));
$$;

-- Bounded queue of messages awaiting approval. Presentation fields plus the review
-- binding only; no proofs, tokens or internal references. Reading changes nothing.
-- Messages whose sending authority is already consumed belong to delivery review.
CREATE FUNCTION public.list_delegated_message_approvals(p_shop uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE reviewer text; items jsonb;
BEGIN
 reviewer:=public.message_approval_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Message approval unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at,q.action_id),'[]') INTO items FROM (
  SELECT a.id AS action_id,a.action_type::text AS action_type,a.created_at,
   c.id AS customer_id,c.name AS customer_name,
   left(coalesce(a.payload->>'to_phone',a.payload->>'to_email'),320) AS destination,
   left(a.payload->>'subject',200) AS subject,left(a.payload->>'body',8000) AS body,
   CASE WHEN a.payload->>'category'='transactional' THEN 'service' ELSE 'marketing' END AS purpose,
   left(a.payload->>'reason',500) AS reason,
   public.control_review_hash(a.payload) AS review_hash
  FROM public.pending_actions a
  LEFT JOIN public.customers c ON c.shop_id=a.shop_id AND c.id::text=a.payload->>'customer_id'
  WHERE a.shop_id=p_shop AND a.status='pending' AND a.action_type::text IN ('send_sms','send_email')
   AND NOT EXISTS(SELECT 1 FROM public.service_proof_consumptions spent WHERE spent.shop_id=a.shop_id AND spent.action_id=a.id)
  ORDER BY a.created_at,a.id LIMIT 21 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('viewer_role',reviewer,'items',items);
END $$;

REVOKE ALL ON FUNCTION public.control_review_hash(jsonb),public.control_claim(uuid,uuid,uuid,text,text),public.claim_delegated_message(uuid,uuid,text),public.message_approval_role(uuid),public.list_delegated_message_approvals(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_delegated_message(uuid,uuid,text),public.list_delegated_message_approvals(uuid,integer) TO authenticated;
COMMIT;
