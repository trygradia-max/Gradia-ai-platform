BEGIN;
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_shop_customer_identity UNIQUE(shop_id,customer_id,id);
ALTER TABLE public.lead_workflows
 ADD COLUMN vehicle_id uuid,
 ADD COLUMN vehicle_snapshot jsonb,
 ADD CONSTRAINT intake_vehicle_customer FOREIGN KEY(shop_id,customer_id,vehicle_id)
 REFERENCES public.vehicles(shop_id,customer_id,id) ON DELETE SET NULL(vehicle_id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT intake_vehicle_snapshot_required CHECK(vehicle_id IS NULL OR (customer_id IS NOT NULL AND vehicle_snapshot IS NOT NULL));

-- Customer changes and new evidence invalidate current vehicle confirmation.
-- The existing immutable decision remains in workflow history.
CREATE FUNCTION public.invalidate_intake_vehicle() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.state='identity_review' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
  NEW.vehicle_id:=NULL; NEW.vehicle_snapshot:=NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invalidate_intake_vehicle() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER invalidate_intake_vehicle BEFORE UPDATE ON public.lead_workflows
 FOR EACH ROW EXECUTE FUNCTION public.invalidate_intake_vehicle();

ALTER TABLE public.lead_workflow_transitions
 DROP CONSTRAINT lead_workflow_transitions_reason_check,
 DROP CONSTRAINT lead_workflow_transitions_check,
 ADD CONSTRAINT lead_workflow_transitions_reason_check CHECK(reason IN ('identity_unresolved','additional_evidence','identity_confirmed','vehicle_confirmed')),
 ADD CONSTRAINT lead_workflow_transitions_check CHECK(
  (reason IN ('identity_confirmed','vehicle_confirmed') AND envelope_id IS NULL AND command_id IS NOT NULL AND decision IS NOT NULL)
  OR (reason IN ('identity_unresolved','additional_evidence') AND envelope_id IS NOT NULL AND command_id IS NULL AND decision IS NULL));

CREATE FUNCTION public.intake_vehicle_choices(p_shop uuid,p_workflow uuid,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.lead_workflows; c public.customers;
BEGIN
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND role='owner' AND active) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 SELECT * INTO w FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow;
 IF w.id IS NULL THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501'; END IF;
 IF p_revision IS NULL OR w.revision<>p_revision OR w.state<>'identity_linked' OR w.customer_id IS NULL THEN RAISE EXCEPTION 'Review changed' USING ERRCODE='PT409'; END IF;
 SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=w.customer_id;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('customer_id',c.id,'customer_updated_at',c.updated_at,
  'vehicles',(SELECT coalesce(jsonb_agg(q.snapshot ORDER BY q.id),'[]'::jsonb) FROM (
   SELECT v.id,jsonb_build_object('id',v.id,'customer_id',v.customer_id,'year',v.year,'make',v.make,'model',v.model,'color',v.color,'plate',v.plate,'updated_at',v.updated_at) AS snapshot FROM public.vehicles v
   WHERE v.shop_id=p_shop AND v.customer_id=c.id ORDER BY v.id LIMIT 50
  ) q));
END $$;

CREATE FUNCTION public.link_intake_vehicle(p_shop uuid,p_workflow uuid,p_revision integer,p_customer uuid,p_customer_updated_at timestamptz,p_vehicle uuid,p_snapshot jsonb,p_command uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.lead_workflows; c public.customers; v public.vehicles; previous public.lead_workflow_transitions; binding jsonb;
BEGIN
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND role='owner' AND active) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_revision IS NULL OR p_revision<1 OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' OR p_customer_updated_at IS NULL THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023'; END IF;
 binding:=jsonb_build_object('customer_id',p_customer,'customer_updated_at',p_customer_updated_at,'vehicle_id',p_vehicle,'snapshot',p_snapshot,'reviewed_revision',p_revision);
 SELECT * INTO previous FROM public.lead_workflow_transitions WHERE command_id=p_command;
 IF previous.id IS NOT NULL THEN
  IF previous.reason<>'vehicle_confirmed' OR previous.shop_id IS DISTINCT FROM p_shop OR previous.workflow_id IS DISTINCT FROM p_workflow OR previous.actor_id IS DISTINCT FROM auth.uid() OR previous.decision IS DISTINCT FROM binding THEN RAISE EXCEPTION 'Command conflict' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('status','already_recorded','workflow_id',p_workflow);
 END IF;
 SELECT * INTO w FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow FOR UPDATE;
 IF w.id IS NULL THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501'; END IF;
 IF w.revision<>p_revision OR w.state<>'identity_linked' OR w.customer_id IS NULL OR w.customer_id IS DISTINCT FROM p_customer THEN RAISE EXCEPTION 'Review changed' USING ERRCODE='PT409'; END IF;
 SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=p_customer FOR SHARE;
 IF c.id IS NULL OR c.updated_at IS DISTINCT FROM p_customer_updated_at THEN RAISE EXCEPTION 'Customer changed' USING ERRCODE='PT409'; END IF;
 SELECT * INTO v FROM public.vehicles WHERE shop_id=p_shop AND customer_id=c.id AND id=p_vehicle FOR SHARE;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Vehicle unavailable' USING ERRCODE='42501'; END IF;
 IF p_snapshot IS DISTINCT FROM jsonb_build_object('id',v.id,'customer_id',v.customer_id,'year',v.year,'make',v.make,'model',v.model,'color',v.color,'plate',v.plate,'updated_at',v.updated_at) THEN RAISE EXCEPTION 'Vehicle changed' USING ERRCODE='PT409'; END IF;
 INSERT INTO public.lead_workflow_transitions(shop_id,workflow_id,envelope_id,from_state,to_state,revision,reason,received_at,actor_id,command_id,decision)
 VALUES(p_shop,w.id,NULL,w.state,w.state,w.revision+1,'vehicle_confirmed',clock_timestamp(),auth.uid(),p_command,binding);
 UPDATE public.lead_workflows SET vehicle_id=v.id,vehicle_snapshot=p_snapshot,revision=w.revision+1,updated_at=clock_timestamp() WHERE shop_id=p_shop AND id=w.id;
 RETURN jsonb_build_object('status','linked','workflow_id',w.id);
END $$;
REVOKE ALL ON FUNCTION public.intake_vehicle_choices(uuid,uuid,integer),public.link_intake_vehicle(uuid,uuid,integer,uuid,timestamptz,uuid,jsonb,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.intake_vehicle_choices(uuid,uuid,integer),public.link_intake_vehicle(uuid,uuid,integer,uuid,timestamptz,uuid,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.read_lead_intake_history(
 p_shop uuid, p_workflow uuid, p_offset integer DEFAULT 0,
 p_limit integer DEFAULT 20, p_revision integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.lead_workflows; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS (
  SELECT 1 FROM public.shop_memberships m JOIN public.shops s ON s.id=m.shop_id
  WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
  AND ((m.role='owner' AND s.owner_id=auth.uid()) OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities)))
 ) THEN RAISE EXCEPTION 'Intake history unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
  OR (p_revision IS NOT NULL AND p_revision<1) OR (p_offset>0 AND p_revision IS NULL) THEN
  RAISE EXCEPTION 'Invalid history page' USING ERRCODE='22023'; END IF;
 SELECT * INTO w FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow;
 IF w.id IS NULL THEN RAISE EXCEPTION 'Intake history unavailable' USING ERRCODE='42501'; END IF;
 IF p_revision IS NOT NULL AND p_revision<>w.revision THEN
  RAISE EXCEPTION 'History changed; refresh required' USING ERRCODE='PT409'; END IF;
 SELECT jsonb_build_object(
  'workflow_id',w.id,'state',w.state,'revision',w.revision,'channel',w.channel,
  'can_link_vehicle',public.team_is_owner(p_shop),'customer_id',w.customer_id,'vehicle_id',w.vehicle_id,
  'vehicle_status',CASE WHEN w.vehicle_id IS NULL THEN 'unresolved' WHEN EXISTS(SELECT 1 FROM public.vehicles v WHERE v.shop_id=w.shop_id AND v.customer_id=w.customer_id AND v.id=w.vehicle_id AND jsonb_build_object('id',v.id,'customer_id',v.customer_id,'year',v.year,'make',v.make,'model',v.model,'color',v.color,'plate',v.plate,'updated_at',v.updated_at)=w.vehicle_snapshot) AND w.state='identity_linked' THEN 'confirmed' ELSE 'needs_review' END,
  'total',(SELECT count(*) FROM public.lead_workflow_transitions WHERE shop_id=p_shop AND workflow_id=w.id),
  'items',coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.revision),'[]'::jsonb)
 ) INTO result FROM (
  SELECT t.revision,t.reason,t.received_at,t.created_at AS recorded_at,t.actor_id,
   CASE WHEN e.id IS NOT NULL THEN (SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
    FROM jsonb_each(e.payload) WHERE key IN ('display_name','phone','email','vehicle_text','service_text','message')) ELSE NULL END AS payload,
   CASE WHEN t.reason='identity_confirmed' THEN jsonb_build_object(
    'id',t.decision->'customer_id','name',t.decision->'snapshot'->'name',
    'phone',t.decision->'snapshot'->'phone','email',t.decision->'snapshot'->'email'
   ) ELSE NULL END AS reviewed_customer,
   CASE WHEN t.reason='vehicle_confirmed' THEN t.decision->'snapshot' ELSE NULL END AS reviewed_vehicle
  FROM public.lead_workflow_transitions t
  LEFT JOIN public.lead_intake_envelopes e ON e.id=t.envelope_id AND e.shop_id=t.shop_id AND e.workflow_id=t.workflow_id
  WHERE t.shop_id=p_shop AND t.workflow_id=w.id
  ORDER BY t.revision LIMIT p_limit OFFSET p_offset
 ) q;
 RETURN result;
END $$;

COMMIT;
