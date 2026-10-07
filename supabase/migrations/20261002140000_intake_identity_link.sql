BEGIN;
ALTER TABLE public.lead_workflows
 DROP CONSTRAINT lead_workflows_state_check,
 DROP CONSTRAINT lead_workflows_handoff_reason_check,
 DROP CONSTRAINT lead_workflows_handoff_pending_check,
 ADD COLUMN customer_id uuid,
 ADD CONSTRAINT lead_workflow_customer FOREIGN KEY(shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE SET NULL(customer_id),
 ADD CHECK(state IN ('identity_review','identity_linked')),
 ADD CHECK(handoff_reason IN ('identity_unresolved','identity_confirmed')),
 ADD CHECK((state='identity_review' AND handoff_pending AND handoff_reason='identity_unresolved') OR (state='identity_linked' AND NOT handoff_pending AND handoff_reason='identity_confirmed'));
ALTER TABLE public.lead_workflow_transitions
 DROP CONSTRAINT lead_workflow_transitions_from_state_check,
 DROP CONSTRAINT lead_workflow_transitions_to_state_check,
 DROP CONSTRAINT lead_workflow_transitions_reason_check,
 ALTER COLUMN envelope_id DROP NOT NULL,
 ADD COLUMN actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 ADD COLUMN command_id uuid UNIQUE,
 ADD COLUMN decision jsonb,
 ADD CHECK(from_state IS NULL OR from_state IN ('identity_review','identity_linked')),
 ADD CHECK(to_state IN ('identity_review','identity_linked')),
 ADD CHECK(reason IN ('identity_unresolved','additional_evidence','identity_confirmed')),
 ADD CHECK((reason='identity_confirmed' AND envelope_id IS NULL AND command_id IS NOT NULL AND decision IS NOT NULL)
  OR (reason<>'identity_confirmed' AND envelope_id IS NOT NULL AND command_id IS NULL AND decision IS NULL));

CREATE FUNCTION public.search_intake_customers(p_shop uuid,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND role='owner' AND active) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF p_query IS NULL OR length(p_query)>100 THEN RAISE EXCEPTION 'Invalid search' USING ERRCODE='22023'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) FROM (
  SELECT id,name,phone,email,updated_at FROM public.customers WHERE shop_id=p_shop
   AND (btrim(p_query)='' OR strpos(lower(coalesce(name,'')||' '||coalesce(phone,'')||' '||coalesce(email,'')),lower(btrim(p_query)))>0)
  ORDER BY updated_at DESC,id DESC LIMIT 20
 ) c);
END $$;

CREATE FUNCTION public.link_intake_customer(p_shop uuid,p_workflow uuid,p_revision integer,p_customer uuid,p_snapshot jsonb,p_command uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.lead_workflows; c public.customers; previous public.lead_workflow_transitions; binding jsonb;
BEGIN
 -- Same shop lock as membership changes, then workflow, then customer.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND role='owner' AND active) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_revision IS NULL OR p_revision<1 OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023'; END IF;
 binding:=jsonb_build_object('customer_id',p_customer,'snapshot',p_snapshot,'reviewed_revision',p_revision);
 SELECT * INTO previous FROM public.lead_workflow_transitions WHERE command_id=p_command;
 IF previous.id IS NOT NULL THEN
  IF previous.shop_id IS DISTINCT FROM p_shop OR previous.workflow_id IS DISTINCT FROM p_workflow OR previous.actor_id IS DISTINCT FROM auth.uid() OR previous.decision IS DISTINCT FROM binding THEN RAISE EXCEPTION 'Command conflict' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('status','already_recorded','workflow_id',p_workflow);
 END IF;
 SELECT * INTO w FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow FOR UPDATE;
 IF w.id IS NULL THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501'; END IF;
 IF w.revision<>p_revision OR w.state<>'identity_review' OR NOT w.handoff_pending THEN RAISE EXCEPTION 'Review changed; refresh required' USING ERRCODE='PT409'; END IF;
 SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=p_customer FOR SHARE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
 IF p_snapshot IS DISTINCT FROM jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,'email',c.email,'updated_at',c.updated_at) THEN RAISE EXCEPTION 'Customer changed; refresh required' USING ERRCODE='PT409'; END IF;
 INSERT INTO public.lead_workflow_transitions(shop_id,workflow_id,envelope_id,from_state,to_state,revision,reason,received_at,actor_id,command_id,decision)
 VALUES(p_shop,w.id,NULL,w.state,'identity_linked',w.revision+1,'identity_confirmed',clock_timestamp(),auth.uid(),p_command,binding);
 UPDATE public.lead_workflows SET customer_id=c.id,state='identity_linked',revision=w.revision+1,handoff_pending=false,handoff_reason='identity_confirmed',updated_at=clock_timestamp() WHERE shop_id=p_shop AND id=w.id;
 RETURN jsonb_build_object('status','linked','workflow_id',w.id);
END $$;
REVOKE ALL ON FUNCTION public.search_intake_customers(uuid,text),public.link_intake_customer(uuid,uuid,integer,uuid,jsonb,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.search_intake_customers(uuid,text),public.link_intake_customer(uuid,uuid,integer,uuid,jsonb,uuid) TO authenticated;

-- New evidence reopens review, including late arrivals; duplicates do not.
CREATE OR REPLACE FUNCTION public.record_lead_intake(
  p_shop uuid,
  p_channel text,
  p_provider text,
  p_event_id text,
  p_received_at timestamptz,
  p_evidence_ref text,
  p_thread_key text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_provider text;
  v_event text;
  v_thread text;
  v_evidence text;
  v_payload jsonb;
  v_existing public.lead_intake_envelopes%ROWTYPE;
  v_workflow_id uuid := NULL;
  v_workflow_state text;
  v_workflow_revision integer;
  v_envelope_id uuid;
  v_transition_id uuid;
  v_revision integer;
  v_from text;
  v_reason text;
  v_result jsonb;
BEGIN
  IF p_shop IS NULL OR NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop) THEN
    RAISE EXCEPTION 'Intake shop is unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('sms', 'website_form', 'meta', 'synthetic') THEN
    RAISE EXCEPTION 'Intake channel is not accepted' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NULL OR p_event_id IS NULL OR p_received_at IS NULL THEN
    RAISE EXCEPTION 'Intake provider, event id, and received time are required' USING ERRCODE = '22023';
  END IF;

  v_provider := btrim(p_provider);
  v_event := btrim(p_event_id);
  IF length(v_provider) NOT BETWEEN 1 AND 64 OR length(p_provider) > 64
     OR length(v_event) NOT BETWEEN 1 AND 512 OR length(p_event_id) > 512 THEN
    RAISE EXCEPTION 'Intake provider event id is not accepted' USING ERRCODE = '22023';
  END IF;

  IF p_evidence_ref IS NULL THEN
    v_evidence := NULL;
  ELSE
    v_evidence := btrim(p_evidence_ref);
    IF length(v_evidence) NOT BETWEEN 1 AND 512 OR length(p_evidence_ref) > 512 THEN
      RAISE EXCEPTION 'Intake evidence reference is not accepted' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_thread_key IS NULL THEN
    v_thread := NULL;
  ELSE
    v_thread := btrim(p_thread_key);
    IF length(v_thread) NOT BETWEEN 1 AND 256 OR length(p_thread_key) > 256 THEN
      RAISE EXCEPTION 'Intake thread key is not accepted' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_payload := public.normalize_lead_intake_payload(p_payload);

  -- Serialize the provider event before any insert. The unique constraint
  -- remains the durable dedupe if two sessions ever pass this lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(48101, pg_catalog.hashtext(v_provider || chr(31) || v_event));

  SELECT * INTO v_existing
    FROM public.lead_intake_envelopes
   WHERE provider = v_provider AND provider_event_id = v_event
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.shop_id IS DISTINCT FROM p_shop THEN
      RAISE EXCEPTION 'Intake event belongs to another shop' USING ERRCODE = '42501';
    END IF;
    v_result := public.lead_intake_result(v_existing.id, 'already_recorded');
    IF v_result IS NULL THEN
      RAISE EXCEPTION 'Intake record could not be reread' USING ERRCODE = '55000';
    END IF;
    RETURN v_result;
  END IF;

  IF v_thread IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      48102,
      pg_catalog.hashtext(p_shop::text || chr(31) || p_channel || chr(31) || v_provider || chr(31) || v_thread)
    );
    SELECT id, state, revision
      INTO v_workflow_id, v_workflow_state, v_workflow_revision
      FROM public.lead_workflows
     WHERE shop_id = p_shop
       AND channel = p_channel
       AND provider = v_provider
       AND thread_key = v_thread
     FOR UPDATE;
  END IF;

  BEGIN
    v_envelope_id := pg_catalog.gen_random_uuid();
    v_transition_id := pg_catalog.gen_random_uuid();
    IF v_workflow_id IS NULL THEN
      v_revision := 1;
      v_from := NULL;
      v_reason := 'identity_unresolved';
      INSERT INTO public.lead_workflows (
        shop_id, channel, provider, thread_key, state, revision,
        last_envelope_id, last_received_at, handoff_reason, handoff_pending
      ) VALUES (
        p_shop, p_channel, v_provider, v_thread, 'identity_review', 1,
        v_envelope_id, p_received_at, 'identity_unresolved', true
      ) RETURNING id INTO v_workflow_id;
    ELSE
      v_revision := v_workflow_revision + 1;
      v_from := v_workflow_state;
      v_reason := 'additional_evidence';
    END IF;

    INSERT INTO public.lead_intake_envelopes (
      id, shop_id, channel, provider, provider_event_id, received_at,
      evidence_ref, thread_key, payload, workflow_id
    ) VALUES (
      v_envelope_id, p_shop, p_channel, v_provider, v_event, p_received_at,
      v_evidence, v_thread, v_payload, v_workflow_id
    );

    INSERT INTO public.lead_workflow_transitions (
      id, shop_id, workflow_id, envelope_id, from_state, to_state,
      revision, reason, received_at
    ) VALUES (
      v_transition_id, p_shop, v_workflow_id, v_envelope_id, v_from, 'identity_review',
      v_revision, v_reason, p_received_at
    );

    IF v_reason = 'additional_evidence' THEN
      UPDATE public.lead_workflows
         SET revision = v_revision,
             state = 'identity_review', handoff_pending = true, handoff_reason = 'identity_unresolved',
             last_envelope_id = CASE
               WHEN p_received_at > last_received_at THEN v_envelope_id
               ELSE last_envelope_id
             END,
             last_received_at = CASE
               WHEN p_received_at > last_received_at THEN p_received_at
               ELSE last_received_at
             END,
             updated_at = pg_catalog.clock_timestamp()
       WHERE shop_id = p_shop AND id = v_workflow_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing
      FROM public.lead_intake_envelopes
     WHERE provider = v_provider AND provider_event_id = v_event;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    IF v_existing.shop_id IS DISTINCT FROM p_shop THEN
      RAISE EXCEPTION 'Intake event belongs to another shop' USING ERRCODE = '42501';
    END IF;
    v_result := public.lead_intake_result(v_existing.id, 'already_recorded');
    IF v_result IS NULL THEN
      RAISE EXCEPTION 'Intake record could not be reread' USING ERRCODE = '55000';
    END IF;
    RETURN v_result;
  END;

  v_result := public.lead_intake_result(v_envelope_id, 'recorded');
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Intake record could not be reread' USING ERRCODE = '55000';
  END IF;
  RETURN v_result;
END $$;


CREATE OR REPLACE FUNCTION public.list_lead_intake_review(p_shop uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS (
  SELECT 1 FROM public.shop_memberships m JOIN public.shops s ON s.id=m.shop_id
  WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
  AND ((m.role='owner' AND s.owner_id=auth.uid()) OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities)))
 ) THEN RAISE EXCEPTION 'Intake review unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
  RAISE EXCEPTION 'Invalid review page' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('total',(SELECT count(*) FROM public.lead_workflows WHERE shop_id=p_shop AND handoff_pending),
  'items',coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.last_received_at DESC,q.id DESC),'[]'::jsonb)) INTO result FROM (
  SELECT w.id,w.channel,w.provider,w.state,w.revision,(SELECT count(*) FROM public.lead_intake_envelopes e2 WHERE e2.shop_id=w.shop_id AND e2.workflow_id=w.id) AS event_count,w.last_received_at,e.payload
  FROM public.lead_workflows w JOIN public.lead_intake_envelopes e
   ON e.shop_id=w.shop_id AND e.workflow_id=w.id AND e.id=w.last_envelope_id
  WHERE w.shop_id=p_shop AND w.handoff_pending
  ORDER BY w.last_received_at DESC,w.id DESC LIMIT p_limit OFFSET p_offset
 ) q;
 RETURN result;
END $$;

-- Preserve the new relationship during the existing explicit atomic merge.
CREATE OR REPLACE FUNCTION public.merge_customers_atomic(p_shop uuid,p_winner uuid,p_loser uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.customers; l public.customers; t text; n integer; moved jsonb='{}'; r public.customer_channel_permissions;
BEGIN
 IF p_winner=p_loser OR p_winner IS NULL OR p_loser IS NULL THEN RAISE EXCEPTION 'Pick two different customers'; END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT EXISTS (SELECT 1 FROM public.shops WHERE id=p_shop AND owner_id=auth.uid()) THEN RAISE EXCEPTION 'Merge not authorized' USING ERRCODE='42501'; END IF;
 -- Deterministic locks serialize both merge directions and parent FK writers.
 PERFORM id FROM public.customers WHERE shop_id=p_shop AND id IN(p_winner,p_loser) ORDER BY id FOR UPDATE;
 SELECT * INTO w FROM public.customers WHERE shop_id=p_shop AND id=p_winner;
 SELECT * INTO l FROM public.customers WHERE shop_id=p_shop AND id=p_loser;
 IF w.id IS NULL OR l.id IS NULL THEN RAISE EXCEPTION 'Both customers must belong to this shop'; END IF;
 PERFORM id FROM public.customer_channel_permissions WHERE shop_id=p_shop AND customer_id IN(p_winner,p_loser) ORDER BY id FOR UPDATE;
 INSERT INTO public.customer_merge_history(shop_id,winner_id,loser_id,evidence)
 VALUES(p_shop,p_winner,p_loser,jsonb_build_object('winner',to_jsonb(w),'loser',to_jsonb(l),'permissions',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.customer_channel_permissions p WHERE shop_id=p_shop AND customer_id IN(p_winner,p_loser)),'[]'::jsonb)));
 FOR r IN SELECT * FROM public.customer_channel_permissions WHERE shop_id=p_shop AND customer_id=p_loser LOOP
   INSERT INTO public.customer_channel_permissions(shop_id,customer_id,channel,destination,suppressed_at,suppression_source,marketing_consent_at,consent_source,created_at)
   VALUES(p_shop,p_winner,r.channel,r.destination,r.suppressed_at,r.suppression_source,r.marketing_consent_at,r.consent_source,r.created_at)
   ON CONFLICT(shop_id,customer_id,channel,destination) DO UPDATE SET
    suppression_source=CASE WHEN customer_channel_permissions.suppressed_at IS NULL THEN EXCLUDED.suppression_source WHEN EXCLUDED.suppressed_at IS NOT NULL AND customer_channel_permissions.suppression_source IS DISTINCT FROM EXCLUDED.suppression_source THEN NULL ELSE customer_channel_permissions.suppression_source END,
    suppressed_at=greatest(customer_channel_permissions.suppressed_at,EXCLUDED.suppressed_at),
    consent_source=CASE WHEN customer_channel_permissions.marketing_consent_at IS NULL OR EXCLUDED.marketing_consent_at IS NULL THEN NULL WHEN customer_channel_permissions.marketing_consent_at<=EXCLUDED.marketing_consent_at THEN customer_channel_permissions.consent_source ELSE EXCLUDED.consent_source END,
    marketing_consent_at=CASE WHEN customer_channel_permissions.marketing_consent_at IS NOT NULL AND EXCLUDED.marketing_consent_at IS NOT NULL THEN least(customer_channel_permissions.marketing_consent_at,EXCLUDED.marketing_consent_at) ELSE NULL END;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['leads','interactions','appointments','vehicles','quotes','payments','call_records','automation_runs','lead_workflows'] LOOP
   EXECUTE format('UPDATE public.%I SET customer_id=$1 WHERE shop_id=$2 AND customer_id=$3',t) USING p_winner,p_shop,p_loser;
   GET DIAGNOSTICS n=ROW_COUNT; moved=moved || jsonb_build_object(t,n);
 END LOOP;
 UPDATE public.pending_actions SET payload=public.merge_customer_json(payload,p_loser,p_winner)
 WHERE shop_id=p_shop AND payload IS DISTINCT FROM public.merge_customer_json(payload,p_loser,p_winner);
 UPDATE public.interactions SET metadata=public.merge_customer_json(metadata,p_loser,p_winner)
 WHERE shop_id=p_shop AND metadata IS DISTINCT FROM public.merge_customer_json(metadata,p_loser,p_winner);
 -- Free unique identifiers inside the same transaction; failures roll back all steps.
 UPDATE public.customers SET phone=NULL,email=NULL WHERE id=p_loser AND shop_id=p_shop;
 UPDATE public.customers SET name=coalesce(w.name,l.name), phone=coalesce(w.phone,l.phone),email=coalesce(w.email,l.email),
  vehicle_make=coalesce(w.vehicle_make,l.vehicle_make),vehicle_model=coalesce(w.vehicle_model,l.vehicle_model),vehicle_year=coalesce(w.vehicle_year,l.vehicle_year),vehicle_color=coalesce(w.vehicle_color,l.vehicle_color),last_visit_at=coalesce(w.last_visit_at,l.last_visit_at),
  marketing_consent_at=CASE WHEN w.marketing_consent_at IS NOT NULL AND l.marketing_consent_at IS NOT NULL THEN least(w.marketing_consent_at,l.marketing_consent_at) ELSE NULL END,
  marketing_consent_source=CASE WHEN w.marketing_consent_at IS NULL OR l.marketing_consent_at IS NULL THEN NULL WHEN w.marketing_consent_at<=l.marketing_consent_at THEN w.marketing_consent_source ELSE l.marketing_consent_source END,
  do_not_contact=coalesce(w.do_not_contact,true) OR coalesce(l.do_not_contact,true),
  sms_opted_out_at=greatest(w.sms_opted_out_at,l.sms_opted_out_at)
 WHERE id=p_winner AND shop_id=p_shop;
 DELETE FROM public.customers WHERE id=p_loser AND shop_id=p_shop;
 RETURN moved;
END $$;

COMMIT;
