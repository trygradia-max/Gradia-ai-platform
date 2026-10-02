BEGIN;
-- Internal only: called by the policy claim in the SAME transaction.
CREATE FUNCTION public.control_apply_record(p_shop uuid,p_action uuid,p_actor uuid,p_type text,p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.customers; v public.vehicles; result uuid; matches uuid[];
 changes jsonb; vehicle jsonb; fields jsonb; k text; value jsonb; ref_table text; ref_id uuid; ref_customer uuid;
BEGIN
 IF p_type='resolve_customer' THEN
  IF NOT (p ?& ARRAY['name','phone','email']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('name','phone','email','source','mcp_token_id'))
   OR (p->>'phone' IS NULL AND p->>'email' IS NULL) THEN RAISE EXCEPTION 'Invalid customer proposal' USING ERRCODE='22023'; END IF;
  changes:=jsonb_strip_nulls(p - ARRAY['source','mcp_token_id']);
 ELSIF p_type='update_customer' THEN
  IF NOT (p ?& ARRAY['customer_id','before','expected_updated_at','changes','vehicle']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('customer_id','before','expected_updated_at','changes','vehicle','source','mcp_token_id'))
   OR jsonb_typeof(p->'changes') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid customer edit' USING ERRCODE='22023'; END IF;
  changes:=p->'changes';
 ELSE changes:='{}'::jsonb;
 END IF;
 FOR k,value IN SELECT * FROM jsonb_each(changes) LOOP
  IF k NOT IN ('name','phone','email') OR jsonb_typeof(value)<>'string' OR length(btrim(value #>> '{}'))=0 OR length(value #>> '{}')>200 THEN RAISE EXCEPTION 'Invalid customer field' USING ERRCODE='22023'; END IF;
  IF k='phone' AND (value #>> '{}') !~ '^\+[1-9][0-9]{6,14}$' THEN RAISE EXCEPTION 'Canonical phone required' USING ERRCODE='22023'; END IF;
  IF k='email' AND ((value #>> '{}') IS DISTINCT FROM public.canonical_contact_destination('email',value #>> '{}')) THEN RAISE EXCEPTION 'Canonical email required' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_type='resolve_customer' THEN
  SELECT array_agg(id) INTO matches FROM public.customers WHERE shop_id=p_shop
   AND ((p->>'phone' IS NOT NULL AND phone_canonical=p->>'phone') OR (p->>'email' IS NOT NULL AND email_canonical=p->>'email'));
  IF cardinality(matches)>1 THEN RAISE EXCEPTION 'Conflicting identities require review' USING ERRCODE='PT409'; END IF;
  IF cardinality(matches)=1 THEN
   SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=matches[1] FOR UPDATE;
   IF (p->>'phone' IS NOT NULL AND c.phone IS NOT NULL AND c.phone_canonical IS DISTINCT FROM p->>'phone')
    OR (p->>'email' IS NOT NULL AND c.email IS NOT NULL AND c.email_canonical IS DISTINCT FROM p->>'email') THEN RAISE EXCEPTION 'Identifier conflict requires review' USING ERRCODE='PT409'; END IF;
   UPDATE public.customers SET name=coalesce(name,p->>'name'),phone=coalesce(phone,p->>'phone'),email=coalesce(email,p->>'email'),updated_at=clock_timestamp() WHERE shop_id=p_shop AND id=c.id RETURNING id INTO result;
  ELSE
   INSERT INTO public.customers(shop_id,name,phone,email) VALUES(p_shop,p->>'name',p->>'phone',p->>'email') RETURNING id INTO result;
  END IF;
 ELSIF p_type='update_customer' THEN
  SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=(p->>'customer_id')::uuid FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
  IF c.updated_at IS DISTINCT FROM (p->>'expected_updated_at')::timestamptz THEN RAISE EXCEPTION 'Customer changed; create a fresh proposal' USING ERRCODE='PT409'; END IF;
  IF p->'before' IS DISTINCT FROM jsonb_build_object('name',c.name,'phone',c.phone,'email',c.email) THEN RAISE EXCEPTION 'Customer snapshot changed' USING ERRCODE='PT409'; END IF;
  vehicle:=p->'vehicle';
  IF changes='{}'::jsonb AND vehicle='null'::jsonb THEN RAISE EXCEPTION 'Empty edit' USING ERRCODE='22023'; END IF;
  UPDATE public.customers SET name=coalesce(changes->>'name',name),phone=coalesce(changes->>'phone',phone),email=coalesce(changes->>'email',email),updated_at=clock_timestamp() WHERE shop_id=p_shop AND id=c.id;
  IF vehicle<>'null'::jsonb THEN
   IF jsonb_typeof(vehicle)<>'object' OR NOT(vehicle ?& ARRAY['id','before','expected_updated_at','changes']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(vehicle) x WHERE x NOT IN ('id','before','expected_updated_at','changes')) OR jsonb_typeof(vehicle->'changes') IS DISTINCT FROM 'object' OR vehicle->'changes'='{}'::jsonb THEN RAISE EXCEPTION 'Invalid vehicle edit' USING ERRCODE='22023'; END IF;
   fields:=vehicle->'changes';
   FOR k,value IN SELECT * FROM jsonb_each(fields) LOOP
    IF k NOT IN ('make','model','year','color') OR (k<>'year' AND (jsonb_typeof(value)<>'string' OR length(btrim(value #>> '{}'))=0 OR length(value #>> '{}')>100)) OR (k='year' AND (jsonb_typeof(value)<>'number' OR (value #>> '{}') !~ '^[0-9]{4}$' OR (value #>> '{}')::integer NOT BETWEEN 1886 AND 2100)) THEN RAISE EXCEPTION 'Invalid vehicle field' USING ERRCODE='22023'; END IF;
   END LOOP;
   IF vehicle->>'id' IS NULL THEN
    IF vehicle->'before' IS DISTINCT FROM 'null'::jsonb OR vehicle->>'expected_updated_at' IS NOT NULL OR NOT(fields ? 'make') OR EXISTS(SELECT 1 FROM public.vehicles WHERE shop_id=p_shop AND customer_id=c.id) THEN RAISE EXCEPTION 'Vehicle selection changed; review required' USING ERRCODE='PT409'; END IF;
    INSERT INTO public.vehicles(shop_id,customer_id,make,model,year,color) VALUES(p_shop,c.id,fields->>'make',fields->>'model',(fields->>'year')::integer,fields->>'color');
   ELSE
    SELECT * INTO v FROM public.vehicles WHERE shop_id=p_shop AND customer_id=c.id AND id=(vehicle->>'id')::uuid FOR UPDATE;
    IF v.id IS NULL THEN RAISE EXCEPTION 'Vehicle unavailable' USING ERRCODE='42501'; END IF;
    IF v.updated_at IS DISTINCT FROM (vehicle->>'expected_updated_at')::timestamptz THEN RAISE EXCEPTION 'Vehicle changed; create a fresh proposal' USING ERRCODE='PT409'; END IF;
    IF vehicle->'before' IS DISTINCT FROM jsonb_build_object('make',v.make,'model',v.model,'year',v.year,'color',v.color) THEN RAISE EXCEPTION 'Vehicle snapshot changed' USING ERRCODE='PT409'; END IF;
    UPDATE public.vehicles SET make=coalesce(fields->>'make',make),model=coalesce(fields->>'model',model),year=coalesce((fields->>'year')::integer,year),color=coalesce(fields->>'color',color),updated_at=clock_timestamp() WHERE shop_id=p_shop AND id=v.id;
   END IF;
  END IF;
  result:=c.id;
 ELSIF p_type='record_interaction' THEN
  IF NOT(p ?& ARRAY['customer_id','channel','role','content','metadata']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('customer_id','channel','role','content','metadata','source','mcp_token_id'))
   OR coalesce(p->>'channel','') NOT IN ('sms','email','voice','web','note') OR coalesce(p->>'role','') NOT IN ('customer','gradia','system')
   OR jsonb_typeof(p->'content') IS DISTINCT FROM 'string' OR length(btrim(p->>'content')) NOT BETWEEN 1 AND 8000
   OR jsonb_typeof(p->'metadata') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid reported history' USING ERRCODE='22023'; END IF;
  IF p->>'customer_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=(p->>'customer_id')::uuid) THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
  FOR k,ref_table IN SELECT * FROM (VALUES('customer_id','customers'),('lead_id','leads'),('vehicle_id','vehicles'),('appointment_id','appointments'),('quote_id','quotes')) t(key,table_name) LOOP
   IF p->'metadata'->>k IS NOT NULL THEN
    EXECUTE format('SELECT id FROM public.%I WHERE shop_id=$1 AND id=$2',ref_table) INTO ref_id USING p_shop,(p->'metadata'->>k)::uuid;
    IF ref_id IS NULL THEN RAISE EXCEPTION 'History reference unavailable' USING ERRCODE='42501'; END IF;
    IF p->>'customer_id' IS NOT NULL THEN
     IF ref_table='customers' THEN ref_customer:=ref_id;
     ELSE EXECUTE format('SELECT customer_id FROM public.%I WHERE shop_id=$1 AND id=$2',ref_table) INTO ref_customer USING p_shop,ref_id; END IF;
     IF ref_customer IS NOT NULL AND ref_customer IS DISTINCT FROM (p->>'customer_id')::uuid THEN RAISE EXCEPTION 'History customer mismatch' USING ERRCODE='42501'; END IF;
    END IF;
   END IF;
  END LOOP;
  -- Agent-reported history is never verified inbound evidence, even after approval.
  -- Keep claimed metadata nested so it cannot satisfy service-purpose proof checks.
  INSERT INTO public.interactions(shop_id,customer_id,channel,role,content,metadata)
  VALUES(p_shop,(p->>'customer_id')::uuid,(p->>'channel')::public.interaction_channel,(p->>'role')::public.interaction_role,btrim(p->>'content'),jsonb_build_object('source','agent_reported','direction','reported','verified',false,'pending_action_id',p_action,'approved_by',p_actor,'reported_metadata',p->'metadata')) RETURNING id INTO result;
 ELSE RAISE EXCEPTION 'Unknown record command' USING ERRCODE='22023'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.control_apply_record(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.control_pending_mode(p_definition jsonb,p_type text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE operations text[]; connector text; op text; selected text; cap text; ceiling text;
 rank integer:=5; r integer; modes text[]:=ARRAY['off','read','suggest','approval','autonomous'];
BEGIN
 IF NOT public.control_validate_draft(p_definition) THEN RETURN 'off'; END IF;
 IF p_definition->'enabled'<>'true'::jsonb THEN RETURN 'off'; END IF;
 CASE p_type
 WHEN 'update_customer' THEN connector:='crm';operations:=ARRAY['crm.edit'];
 WHEN 'resolve_customer' THEN connector:='crm';operations:=ARRAY['identity.review'];
 WHEN 'record_interaction' THEN connector:='memory';operations:=ARRAY['memory.publish.customer','memory.publish.shop'];
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
 IF p_type IN ('book_appointment','reschedule_appointment','cancel_appointment','create_quote','create_lead','update_customer','resolve_customer','record_interaction') THEN rank:=least(rank,4); END IF;
 RETURN coalesce(modes[rank],'off');
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
CREATE OR REPLACE FUNCTION public.stage_agent_capture(
 p_shop uuid, p_actor uuid, p_command uuid, p_type text, p_payload jsonb,
 p_source text, p_token uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing public.pending_actions; bound jsonb;
BEGIN
 -- Same serialization lock as membership/policy changes; service callers have
 -- no auth.uid(), so perform the explicit actor/token checks below.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF p_source IS NULL OR p_source NOT IN ('owner_agent','mcp') OR p_type IS NULL
 OR p_type NOT IN ('add_note','create_lead','update_customer','resolve_customer','record_interaction') OR p_command IS NULL
 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
  RAISE EXCEPTION 'Invalid capture command' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.shops s JOIN public.shop_memberships m ON m.shop_id=s.id
  WHERE s.id=p_shop AND s.owner_id=p_actor AND m.user_id=p_actor AND m.active AND m.role='owner' AND NOT coalesce(s.simulation_mode,false))
 OR (auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS DISTINCT FROM p_actor OR p_source<>'owner_agent')) THEN
  RAISE EXCEPTION 'Capture actor unavailable' USING ERRCODE='42501';
 END IF;
 IF p_source='mcp' THEN
  IF p_token IS NULL OR NOT EXISTS(SELECT 1 FROM public.mcp_tokens WHERE id=p_token AND shop_id=p_shop AND revoked_at IS NULL FOR SHARE) THEN
   RAISE EXCEPTION 'Capture token unavailable' USING ERRCODE='42501';
  END IF;
 ELSIF p_token IS NOT NULL THEN RAISE EXCEPTION 'Unexpected token' USING ERRCODE='22023'; END IF;
 IF p_type IN ('update_customer','record_interaction') AND p_payload->>'customer_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=(p_payload->>'customer_id')::uuid) THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
 IF p_type='update_customer' AND p_payload->'vehicle'->>'id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.vehicles WHERE shop_id=p_shop AND customer_id=(p_payload->>'customer_id')::uuid AND id=(p_payload->'vehicle'->>'id')::uuid) THEN RAISE EXCEPTION 'Vehicle unavailable' USING ERRCODE='42501'; END IF;
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

COMMIT;
