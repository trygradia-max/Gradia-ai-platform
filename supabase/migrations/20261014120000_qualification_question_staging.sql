BEGIN;
-- Queues one owner-reviewed qualification question as a pending message approval.
-- Reuses whisper_command's reply staging in the same transaction: no second
-- executor, no new action type, nothing sent. See docs/architecture/LEAD_QUALIFICATION.md.
CREATE FUNCTION public.stage_qualification_question(
 p_shop uuid,p_workflow uuid,p_command uuid,p_revision integer,p_evidence_revision integer,
 p_target text,p_question uuid,p_channel text,p_latest uuid,p_conversation_revision integer,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE binding jsonb; prior public.pending_actions; snap jsonb; c public.customers; s public.shops;
 v_destination text; replay boolean:=false; v_customer uuid; expected_target text; expected_question uuid;
BEGIN
 -- Same lock order as qualification saves and intake review: shop, then workflow.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 -- Authority before the retry check, so a revoked caller's exact retry is refused.
 IF auth.uid() IS NULL OR public.lead_qualification_role(p_shop,false) IS DISTINCT FROM 'owner' OR NOT public.team_is_owner(p_shop) THEN
  RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501',DETAIL='forbidden'; END IF;
 IF p_workflow IS NULL OR p_command IS NULL THEN RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023',DETAIL='command'; END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_evidence_revision<1 THEN RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023',DETAIL='basis'; END IF;
 IF p_target IS NULL OR p_target NOT IN ('service','vehicle_condition','timing','location','constraints','open_question')
  OR (p_target='open_question') IS DISTINCT FROM (p_question IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023',DETAIL='target'; END IF;
 IF p_channel IS NULL OR p_channel NOT IN ('sms','email') THEN RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023',DETAIL='channel'; END IF;
 binding:=jsonb_build_object('workflow_id',p_workflow,'revision',p_revision,'evidence_revision',p_evidence_revision,'target',p_target,'question_id',p_question);

 SELECT * INTO prior FROM public.pending_actions WHERE id=p_command;
 IF prior.id IS NOT NULL THEN
  -- Exact retry: whisper_command below compares its own binding and actor.
  IF prior.shop_id<>p_shop OR prior.payload->'qualification' IS DISTINCT FROM binding THEN
   RAISE EXCEPTION 'Command conflict' USING ERRCODE='PT409',DETAIL='command_conflict'; END IF;
  replay:=true;
  v_customer:=(prior.payload->>'customer_id')::uuid;
 ELSE
  PERFORM 1 FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501',DETAIL='forbidden'; END IF;
  snap:=public.lead_qualification_snapshot(p_shop,p_workflow);
  IF (snap->>'revision')::integer<>p_revision OR (snap->'identity'->>'evidence_revision')::integer IS DISTINCT FROM p_evidence_revision THEN
   RAISE EXCEPTION 'Qualification changed' USING ERRCODE='PT409',DETAIL='qualification_changed'; END IF;
  IF snap->'identity'->>'state'<>'identity_linked' OR snap->'identity'->>'customer_id' IS NULL OR snap->>'review_state'='needs_review'
   OR jsonb_array_length(snap->'review_reasons')>0 THEN
   RAISE EXCEPTION 'Review required' USING ERRCODE='PT409',DETAIL='review_required'; END IF;
  -- The target must be the current proposal (proposeNextQualificationQuestion):
  -- the first open question, else the first unknown field in the fixed order.
  SELECT (x->>'id')::uuid INTO expected_question FROM jsonb_array_elements(snap->'open_questions') WITH ORDINALITY q(x,n)
   WHERE x->>'status'='open' ORDER BY n LIMIT 1;
  IF expected_question IS NOT NULL THEN expected_target:='open_question';
  ELSE
   SELECT f INTO expected_target FROM unnest(ARRAY['service','vehicle_condition','timing','location','constraints']) WITH ORDINALITY u(f,n)
    WHERE snap->'fields'->f->>'status'='unknown' ORDER BY n LIMIT 1;
  END IF;
  IF expected_target IS DISTINCT FROM p_target OR expected_question IS DISTINCT FROM p_question THEN
   RAISE EXCEPTION 'Question resolved' USING ERRCODE='PT409',DETAIL='question_resolved'; END IF;
  v_customer:=(snap->'identity'->>'customer_id')::uuid;

  -- Contact hard stops, matching the executor's own denials. Consent to market is
  -- deliberately left to the executor, where reply-purpose proof can apply.
  SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=v_customer;
  v_destination:=public.canonical_contact_destination(p_channel,CASE p_channel WHEN 'sms' THEN c.phone ELSE c.email END);
  IF c.do_not_contact IS DISTINCT FROM false OR (p_channel='sms' AND c.sms_opted_out_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.customer_channel_permissions p WHERE p.shop_id=p_shop AND p.customer_id=c.id
    AND p.channel=p_channel AND p.destination=v_destination AND p.suppressed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Contact blocked' USING ERRCODE='PT409',DETAIL='contact_blocked'; END IF;

  -- Same predicates as connectionStatus and smsGateForShop. The executor rechecks at send.
  SELECT * INTO s FROM public.shops WHERE id=p_shop;
  IF (p_channel='sms' AND (nullif(btrim(coalesce(s.twilio_phone_number,'')),'') IS NULL
    OR NOT (CASE WHEN s.gradia_number_e164 IS NOT NULL AND s.twilio_phone_number=s.gradia_number_e164 THEN s.a2p_status='approved' ELSE coalesce(s.byo_sms_verified,false) END)))
   OR (p_channel='email' AND (nullif(btrim(coalesce(s.aurinko_access_token_enc,'')),'') IS NULL OR s.aurinko_account_id IS NULL)) THEN
   RAISE EXCEPTION 'Channel unavailable' USING ERRCODE='PT409',DETAIL='channel_unavailable'; END IF;

  -- One waiting question per lead, including uncertain delivery after any decision.
  -- Match the inbox hold: a decision/result alone cannot clear a consumed send claim.
  IF EXISTS(SELECT 1 FROM public.pending_actions a WHERE a.shop_id=p_shop AND a.action_type::text IN ('send_sms','send_email')
   AND a.payload->'qualification'->>'workflow_id'=p_workflow::text
   AND (a.status IN ('pending','edit_requested') OR (a.status='approved' AND a.result_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.service_proof_consumptions spent WHERE spent.shop_id=p_shop AND spent.action_id=a.id
      AND (spent.completed_at IS NULL OR a.result_id IS NULL OR a.status<>'approved')))) THEN
   RAISE EXCEPTION 'Question pending' USING ERRCODE='PT409',DETAIL='question_pending'; END IF;
 END IF;

 BEGIN
  PERFORM public.whisper_command(p_shop,v_customer,p_channel,p_command,p_latest,p_conversation_revision,'reply',p_payload);
 EXCEPTION
  WHEN SQLSTATE 'PT409' THEN
   RAISE EXCEPTION 'Not queued' USING ERRCODE='PT409',DETAIL=CASE SQLERRM WHEN 'Recipient changed' THEN 'recipient_changed'
    WHEN 'Conversation changed; refresh' THEN 'conversation_changed' WHEN 'Command conflict' THEN 'command_conflict' ELSE 'not_confirmed' END;
  WHEN insufficient_privilege THEN
   RAISE EXCEPTION 'Not queued' USING ERRCODE='42501',DETAIL=CASE WHEN SQLERRM='Current policy does not permit executable staging' THEN 'policy_blocked' ELSE 'forbidden' END;
  WHEN invalid_parameter_value THEN
   RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023',DETAIL='message';
 END;
 IF NOT replay THEN
  UPDATE public.pending_actions SET payload=payload||jsonb_build_object('qualification',binding) WHERE id=p_command AND shop_id=p_shop;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not queued' USING ERRCODE='PT409',DETAIL='not_confirmed'; END IF;
 END IF;
 RETURN jsonb_build_object('status',CASE WHEN replay THEN 'already_queued' ELSE 'queued' END,'action_id',p_command,
  'workflow_id',p_workflow,'channel',p_channel,'qualification',binding);
END $$;
REVOKE ALL ON FUNCTION public.stage_qualification_question(uuid,uuid,uuid,integer,integer,text,uuid,text,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_qualification_question(uuid,uuid,uuid,integer,integer,text,uuid,text,uuid,integer,jsonb) TO authenticated;
COMMIT;
