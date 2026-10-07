BEGIN;
-- Fail-closed rollout: existing tokens receive no implicit capability grants.
ALTER TABLE public.mcp_tokens ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.mcp_tokens ADD CONSTRAINT mcp_capabilities_known CHECK (
 array_position(capabilities,NULL) IS NULL AND capabilities <@ ARRAY['find_customer_by_channel','search_customer_memory','search_shop_knowledge','recent_channel_activity','list_services','shop_snapshot','recent_customers','active_leads','customer_detail','customer_timeline','propose_lead','find_or_create_customer','record_interaction','propose_booking','propose_sms','propose_email']::text[]);
CREATE FUNCTION public.mcp_proposal_capability(p_type text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE p_type WHEN 'create_lead' THEN 'propose_lead' WHEN 'resolve_customer' THEN 'find_or_create_customer'
 WHEN 'record_interaction' THEN 'record_interaction' WHEN 'book_appointment' THEN 'propose_booking'
 WHEN 'send_sms' THEN 'propose_sms' WHEN 'send_email' THEN 'propose_email' ELSE NULL END
$$;
REVOKE ALL ON FUNCTION public.mcp_proposal_capability(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.stage_agent_capture(
 p_shop uuid, p_actor uuid, p_command uuid, p_type text, p_payload jsonb,
 p_source text, p_token uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing public.pending_actions; bound jsonb; customer public.customers;
BEGIN
 -- Same serialization lock as membership/policy changes; service callers have
 -- no auth.uid(), so perform the explicit actor/token checks below.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF p_source IS NULL OR p_source NOT IN ('owner_agent','mcp') OR p_type IS NULL
 OR p_type NOT IN ('add_note','create_lead','update_customer','resolve_customer','record_interaction','send_sms','send_email','book_appointment') OR p_command IS NULL
 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
  RAISE EXCEPTION 'Invalid capture command' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.shops s JOIN public.shop_memberships m ON m.shop_id=s.id
  WHERE s.id=p_shop AND s.owner_id=p_actor AND m.user_id=p_actor AND m.active AND m.role='owner' AND NOT coalesce(s.simulation_mode,false))
 OR (auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS DISTINCT FROM p_actor OR p_source<>'owner_agent')) THEN
  RAISE EXCEPTION 'Capture actor unavailable' USING ERRCODE='42501';
 END IF;
 IF p_source='mcp' THEN
  IF p_token IS NULL OR NOT EXISTS(SELECT 1 FROM public.mcp_tokens WHERE id=p_token AND shop_id=p_shop AND revoked_at IS NULL AND public.mcp_proposal_capability(p_type)=ANY(capabilities) FOR SHARE) THEN
   RAISE EXCEPTION 'Capture token unavailable' USING ERRCODE='42501';
  END IF;
 ELSIF p_token IS NOT NULL THEN RAISE EXCEPTION 'Unexpected token' USING ERRCODE='22023'; END IF;
 IF p_type IN ('update_customer','record_interaction') AND p_payload->>'customer_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=(p_payload->>'customer_id')::uuid) THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
 IF p_type='update_customer' AND p_payload->'vehicle'->>'id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.vehicles WHERE shop_id=p_shop AND customer_id=(p_payload->>'customer_id')::uuid AND id=(p_payload->'vehicle'->>'id')::uuid) THEN RAISE EXCEPTION 'Vehicle unavailable' USING ERRCODE='42501'; END IF;
 IF p_type IN ('send_sms','send_email','book_appointment') THEN
  IF p_source<>'mcp' THEN RAISE EXCEPTION 'MCP proposal required' USING ERRCODE='42501'; END IF;
  SELECT * INTO customer FROM public.customers WHERE shop_id=p_shop AND id=(p_payload->>'customer_id')::uuid;
  IF customer.id IS NULL THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
  IF p_type='send_sms' AND (public.canonical_contact_destination('sms',p_payload->>'to_phone') IS NULL
   OR p_payload->>'to_phone' IS DISTINCT FROM customer.phone_canonical) THEN RAISE EXCEPTION 'Recipient mismatch' USING ERRCODE='42501'; END IF;
  IF p_type='send_email' AND (public.canonical_contact_destination('email',p_payload->>'to_email') IS NULL
   OR p_payload->>'to_email' IS DISTINCT FROM customer.email_canonical) THEN RAISE EXCEPTION 'Recipient mismatch' USING ERRCODE='42501'; END IF;
  IF p_type IN ('send_sms','send_email') AND (p_payload->>'category' IS DISTINCT FROM 'marketing'
   OR length(trim(coalesce(p_payload->>'body','')))=0 OR length(p_payload->>'body')>CASE WHEN p_type='send_sms' THEN 1600 ELSE 8000 END
   OR p_payload ? 'service_proof') THEN RAISE EXCEPTION 'Invalid message proposal' USING ERRCODE='22023'; END IF;
  IF p_type='send_email' AND (length(trim(coalesce(p_payload->>'subject','')))=0 OR length(p_payload->>'subject')>200) THEN RAISE EXCEPTION 'Invalid subject' USING ERRCODE='22023'; END IF;
  IF p_type='book_appointment' AND (p_payload->>'phone' IS DISTINCT FROM customer.phone_canonical
   OR customer.phone_canonical IS NULL OR ((p_payload->>'email') IS NOT NULL AND p_payload->>'email' IS DISTINCT FROM customer.email_canonical)
   OR (p_payload->>'iso_start_time')::timestamptz IS NULL OR NOT isfinite((p_payload->>'iso_start_time')::timestamptz)
   OR (p_payload->>'duration_minutes')::integer IS NULL OR (p_payload->>'duration_minutes')::integer NOT BETWEEN 15 AND 1440) THEN RAISE EXCEPTION 'Invalid booking proposal' USING ERRCODE='22023'; END IF;
  -- Never accept hidden proof/reference/transport controls through direct RPC calls.
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT k=ANY(CASE p_type
   WHEN 'send_sms' THEN ARRAY['customer_id','customer_name','to_phone','body','category','reason']
   WHEN 'send_email' THEN ARRAY['customer_id','customer_name','to_email','subject','body','category','reason']
   ELSE ARRAY['customer_id','customer_name','phone','email','car_info','service','iso_start_time','duration_minutes','timezone','pin_notes'] END)) THEN RAISE EXCEPTION 'Unknown proposal field' USING ERRCODE='22023'; END IF;
 END IF;
 -- Bind attribution in trusted code, never use the model-supplied source label.
 bound:=p_payload || jsonb_build_object('source',p_source,'mcp_token_id',p_token);
 SELECT * INTO existing FROM public.pending_actions WHERE id=p_command;
 IF existing.id IS NOT NULL THEN
  IF existing.shop_id<>p_shop OR existing.requested_by IS DISTINCT FROM p_actor
   OR existing.action_type::text<>p_type OR existing.payload IS DISTINCT FROM bound THEN
   RAISE EXCEPTION 'Command identity conflict' USING ERRCODE='PT409';
  END IF;
  RETURN existing.id;
 END IF;
 INSERT INTO public.pending_actions(id,shop_id,requested_by,action_type,payload)
 VALUES(p_command,p_shop,p_actor,p_type::public.pending_action_type,bound);
 RETURN p_command;
END $$;

CREATE OR REPLACE FUNCTION public.claim_control_action(p_shop uuid,p_action uuid,p_actor uuid,p_context text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE shop public.shops; action public.pending_actions; revision integer; definition jsonb; location uuid;
 record_id uuid; effective text:='approval'; reason text; allowed boolean:=false;
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
 -- Token permission is required again at approval, including old queued MCP work.
 IF action.payload->>'source'='mcp' AND NOT EXISTS(SELECT 1 FROM public.mcp_tokens
  WHERE id=(action.payload->>'mcp_token_id')::uuid AND shop_id=p_shop AND revoked_at IS NULL
  AND public.mcp_proposal_capability(action.action_type::text)=ANY(capabilities) FOR SHARE) THEN
  RETURN jsonb_build_object('denied','mcp_capability_unavailable');
 END IF;
 SELECT a.revision,h.definition INTO revision,definition FROM public.control_policy_active a
 JOIN public.control_policy_history h ON h.shop_id=a.shop_id AND h.revision=a.revision WHERE a.shop_id=p_shop;
 IF revision IS NOT NULL THEN effective:=public.control_pending_mode(definition,action.action_type::text); END IF;
 -- Unknown actions fail closed even before activation.
 IF action.action_type::text NOT IN ('create_lead','add_note','send_sms','send_email','book_appointment','reschedule_appointment','cancel_appointment','create_quote','update_customer','resolve_customer','record_interaction') THEN effective:='off'; END IF;
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
 IF action.action_type::text IN ('update_customer','resolve_customer','record_interaction') THEN
  record_id:=public.control_apply_record(p_shop,p_action,p_actor,action.action_type::text,action.payload);
 END IF;
 UPDATE public.pending_actions SET result_id=coalesce(record_id,result_id),status='approved',decided_at=now(),decided_by_user=p_actor WHERE id=p_action AND shop_id=p_shop;
 RETURN jsonb_build_object('id',action.id,'shop_id',action.shop_id,'action_type',action.action_type,'payload',action.payload,'result_id',record_id);
END $$;

COMMIT;
