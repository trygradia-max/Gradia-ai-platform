BEGIN;
-- Durable lead qualification, first backend slice of MVP sequence step 5.
--
-- One qualification record per intake workflow. It stores what a human reviewer
-- recorded about the request; it never stores its own customer or vehicle identity.
-- Identity stays on the workflow's reviewed customer and vehicle links, and a
-- qualification is only current while those links and the evidence it was reviewed
-- against are unchanged. Unknown is an explicit value on every field.
--
-- Nothing here creates a customer, vehicle, lead, quote, booking, consent record or
-- message, calls a provider or a model, or advances the workflow state machine.

DO $$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['shop_memberships','shop_invitations'] LOOP
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target,target||'_capabilities_known');
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (capabilities <@ ARRAY[''crm.read'',''notes.write'',''jobs.progress'',''assignments.manage'',''delivery.reconcile'',''approvals.messages'',''leads.qualify'']::text[])',target,target||'_capabilities_known');
  -- A qualifier must be able to read the customer and intake evidence involved.
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (NOT (''leads.qualify''=ANY(capabilities)) OR ''crm.read''=ANY(capabilities))',target,target||'_lead_qualify_needs_read');
 END LOOP;
END $$;

-- Free text recorded by a reviewer: trimmed, bounded, no hidden control characters.
CREATE FUNCTION public.lead_qualification_text_ok(p_value jsonb,p_max integer,p_nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE
  WHEN p_value IS NULL OR jsonb_typeof(p_value)='null' THEN p_nullable
  WHEN jsonb_typeof(p_value)<>'string' THEN false
  ELSE char_length(p_value #>> '{}') BETWEEN 1 AND p_max
   AND (p_value #>> '{}')=btrim(p_value #>> '{}')
   AND regexp_replace(p_value #>> '{}',E'[\n\r\t]','','g') !~ '[[:cntrl:]]' END
$$;

-- Returns NULL when the document is valid, otherwise the path that was refused.
-- Every field is always present with an explicit status; a missing field is invalid,
-- so absence can never be read as a completed answer.
CREATE FUNCTION public.lead_qualification_invalid_path(p_fields jsonb,p_questions jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE name text; field jsonb; status text; source text; bound text; allowed text[]; item jsonb; seen text[]:='{}'; earliest date; latest date;
BEGIN
 IF p_fields IS NULL OR jsonb_typeof(p_fields)<>'object' THEN RETURN 'fields'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_fields))<>5 OR NOT p_fields ?& ARRAY['service','vehicle_condition','timing','location','constraints'] THEN RETURN 'fields'; END IF;
 FOREACH name IN ARRAY ARRAY['service','vehicle_condition','timing','location','constraints'] LOOP
  field:=p_fields->name;
  IF jsonb_typeof(field)<>'object' THEN RETURN 'fields.'||name; END IF;
  allowed:=ARRAY['status','source','evidence_revision'] || CASE name
   WHEN 'service' THEN ARRAY['service_id','text'] WHEN 'vehicle_condition' THEN ARRAY['text']
   WHEN 'timing' THEN ARRAY['earliest','latest','text'] WHEN 'location' THEN ARRAY['type','area'] ELSE ARRAY['items'] END;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(field) k WHERE NOT k=ANY(allowed)) OR NOT field ?& allowed THEN RETURN 'fields.'||name; END IF;
  IF jsonb_typeof(field->'status')<>'string' THEN RETURN 'fields.'||name||'.status'; END IF;
  status:=field->>'status';
  IF status NOT IN ('unknown','reported','confirmed') THEN RETURN 'fields.'||name||'.status'; END IF;
  -- Provenance: who the information came from. Unknown carries none.
  source:=field->>'source';
  IF (status='unknown' AND jsonb_typeof(field->'source')<>'null')
   OR (status<>'unknown' AND (jsonb_typeof(field->'source')<>'string' OR source NOT IN ('customer','staff','intake'))) THEN RETURN 'fields.'||name||'.source'; END IF;
  IF jsonb_typeof(field->'evidence_revision')='null' THEN
   IF source='intake' THEN RETURN 'fields.'||name||'.evidence_revision'; END IF;
  ELSIF source IS DISTINCT FROM 'intake' OR jsonb_typeof(field->'evidence_revision')<>'number'
   OR (field->>'evidence_revision') !~ '^[1-9][0-9]{0,8}$' THEN RETURN 'fields.'||name||'.evidence_revision'; END IF;
  IF name='service' THEN
   IF NOT (jsonb_typeof(field->'service_id')='null' OR (jsonb_typeof(field->'service_id')='string'
     AND (field->>'service_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN RETURN 'fields.service.service_id'; END IF;
   IF NOT public.lead_qualification_text_ok(field->'text',200,true) THEN RETURN 'fields.service.text'; END IF;
   IF (status='unknown')<>(jsonb_typeof(field->'service_id')='null' AND jsonb_typeof(field->'text')='null') THEN RETURN 'fields.service'; END IF;
  ELSIF name='vehicle_condition' THEN
   IF NOT public.lead_qualification_text_ok(field->'text',1000,status='unknown') OR (status='unknown' AND jsonb_typeof(field->'text')<>'null') THEN RETURN 'fields.vehicle_condition.text'; END IF;
  ELSIF name='timing' THEN
   FOREACH bound IN ARRAY ARRAY['earliest','latest'] LOOP
    IF NOT (jsonb_typeof(field->bound)='null' OR (jsonb_typeof(field->bound)='string' AND (field->>bound) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')) THEN RETURN 'fields.timing.'||bound; END IF;
   END LOOP;
   BEGIN earliest:=(field->>'earliest')::date; latest:=(field->>'latest')::date;
   EXCEPTION WHEN others THEN RETURN 'fields.timing'; END;
   IF earliest IS NOT NULL AND latest IS NOT NULL AND latest<earliest THEN RETURN 'fields.timing.latest'; END IF;
   IF NOT public.lead_qualification_text_ok(field->'text',300,true) THEN RETURN 'fields.timing.text'; END IF;
   IF (status='unknown')<>(earliest IS NULL AND latest IS NULL AND jsonb_typeof(field->'text')='null') THEN RETURN 'fields.timing'; END IF;
  ELSIF name='location' THEN
   IF NOT (jsonb_typeof(field->'type')='null' OR (jsonb_typeof(field->'type')='string' AND field->>'type' IN ('shop','mobile'))) THEN RETURN 'fields.location.type'; END IF;
   IF NOT public.lead_qualification_text_ok(field->'area',200,true) THEN RETURN 'fields.location.area'; END IF;
   IF (status='unknown' AND NOT (jsonb_typeof(field->'type')='null' AND jsonb_typeof(field->'area')='null'))
    OR (status<>'unknown' AND jsonb_typeof(field->'type')='null') THEN RETURN 'fields.location'; END IF;
  ELSE
   -- A reviewed empty list means "no constraints"; unknown means nobody has asked.
   IF jsonb_typeof(field->'items')<>'array' OR jsonb_array_length(field->'items')>10
    OR (status='unknown' AND jsonb_array_length(field->'items')>0) THEN RETURN 'fields.constraints.items'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(field->'items') LOOP
    IF NOT public.lead_qualification_text_ok(item,200,false) THEN RETURN 'fields.constraints.items'; END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF p_questions IS NULL OR jsonb_typeof(p_questions)<>'array' OR jsonb_array_length(p_questions)>20 THEN RETURN 'open_questions'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_questions) LOOP
  IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>4 OR NOT item ?& ARRAY['id','text','status','answer'] THEN RETURN 'open_questions'; END IF;
  IF jsonb_typeof(item->'id')<>'string' OR (item->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR (item->>'id')=ANY(seen) THEN RETURN 'open_questions.id'; END IF;
  seen:=array_append(seen,item->>'id');
  IF NOT public.lead_qualification_text_ok(item->'text',500,false) THEN RETURN 'open_questions.text'; END IF;
  IF jsonb_typeof(item->'status')<>'string' OR item->>'status' NOT IN ('open','answered','dropped') THEN RETURN 'open_questions.status'; END IF;
  IF NOT public.lead_qualification_text_ok(item->'answer',1000,item->>'status'<>'answered') OR (item->>'status'<>'answered' AND jsonb_typeof(item->'answer')<>'null') THEN RETURN 'open_questions.answer'; END IF;
 END LOOP;
 RETURN NULL;
END $$;

CREATE TABLE public.lead_qualifications (
 shop_id uuid NOT NULL,
 workflow_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision>0),
 review_state text NOT NULL CHECK (review_state IN ('in_progress','reviewed')),
 fields jsonb NOT NULL,
 open_questions jsonb NOT NULL,
 -- What the reviewer was looking at. Compared with the live workflow on every read;
 -- deliberately not foreign keys, so a merge or relink forces a fresh review.
 reviewed_customer_id uuid NOT NULL,
 reviewed_vehicle_id uuid,
 reviewed_evidence_revision integer NOT NULL CHECK (reviewed_evidence_revision>0),
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (shop_id,workflow_id),
 FOREIGN KEY (shop_id,workflow_id) REFERENCES public.lead_workflows(shop_id,id) ON DELETE CASCADE,
 CHECK (public.lead_qualification_invalid_path(fields,open_questions) IS NULL)
);
-- Append-only audit: one row per accepted command, holding the full reviewed document.
CREATE TABLE public.lead_qualification_revisions (
 command_id uuid PRIMARY KEY,
 shop_id uuid NOT NULL,
 workflow_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision>0),
 actor_id uuid NOT NULL,
 actor_role text NOT NULL CHECK (actor_role IN ('owner','manager')),
 actor_label text NOT NULL,
 review_state text NOT NULL CHECK (review_state IN ('in_progress','reviewed')),
 fields jsonb NOT NULL,
 open_questions jsonb NOT NULL,
 reviewed_customer_id uuid NOT NULL,
 reviewed_vehicle_id uuid,
 reviewed_evidence_revision integer NOT NULL,
 binding jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (shop_id,workflow_id,revision),
 FOREIGN KEY (shop_id,workflow_id) REFERENCES public.lead_qualifications(shop_id,workflow_id) ON DELETE CASCADE
);
ALTER TABLE public.lead_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_qualification_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_qualifications,public.lead_qualification_revisions FROM PUBLIC,anon,authenticated,service_role;

-- Private. Live reviewing role of the signed-in caller, or NULL.
-- Reading follows the existing CRM read grant; writing needs the explicit grant.
CREATE FUNCTION public.lead_qualification_role(p_shop uuid,p_write boolean) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.role FROM public.shop_memberships m JOIN public.shops s ON s.id=m.shop_id
 WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
 AND ((m.role='owner' AND s.owner_id=m.user_id)
  OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities) AND (NOT p_write OR 'leads.qualify'=ANY(m.capabilities))));
$$;

-- Private. The single presentation of a workflow's qualification, used by every
-- read and returned by every write, so no caller computes review state itself.
CREATE FUNCTION public.lead_qualification_snapshot(p_shop uuid,p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.lead_workflows; q public.lead_qualifications; c public.customers; v public.vehicles;
 vehicle_status text; evidence integer; reasons text[]:='{}'; missing text[]:='{}'; open_count integer:=0;
 doc jsonb; field_name text; actor public.lead_qualification_revisions;
BEGIN
 SELECT * INTO w FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow;
 IF w.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO q FROM public.lead_qualifications WHERE shop_id=p_shop AND workflow_id=p_workflow;
 SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=w.customer_id;
 SELECT * INTO v FROM public.vehicles WHERE shop_id=p_shop AND customer_id=w.customer_id AND id=w.vehicle_id;
 -- Same definition as intake history: a link is confirmed only against the live record.
 vehicle_status:=CASE WHEN w.vehicle_id IS NULL THEN 'unresolved'
  WHEN w.state='identity_linked' AND v.id IS NOT NULL AND jsonb_build_object('id',v.id,'customer_id',v.customer_id,'year',v.year,'make',v.make,'model',v.model,'color',v.color,'plate',v.plate,'updated_at',v.updated_at)=w.vehicle_snapshot THEN 'confirmed'
  ELSE 'needs_review' END;
 SELECT max(t.revision) INTO evidence FROM public.lead_workflow_transitions t WHERE t.shop_id=p_shop AND t.workflow_id=p_workflow AND t.envelope_id IS NOT NULL;
 IF w.state<>'identity_linked' OR c.id IS NULL THEN reasons:=array_append(reasons,'identity_in_review'); END IF;
 IF q.workflow_id IS NOT NULL THEN
  IF c.id IS NOT NULL AND q.reviewed_customer_id IS DISTINCT FROM w.customer_id THEN reasons:=array_append(reasons,'customer_changed'); END IF;
  IF q.reviewed_vehicle_id IS DISTINCT FROM w.vehicle_id OR vehicle_status='needs_review' THEN reasons:=array_append(reasons,'vehicle_changed'); END IF;
  IF q.reviewed_evidence_revision IS DISTINCT FROM evidence THEN reasons:=array_append(reasons,'new_evidence'); END IF;
  SELECT * INTO actor FROM public.lead_qualification_revisions WHERE shop_id=p_shop AND workflow_id=p_workflow AND revision=q.revision;
 END IF;
 doc:=coalesce(q.fields,jsonb_build_object(
  'service',jsonb_build_object('status','unknown','source',NULL,'evidence_revision',NULL,'service_id',NULL,'text',NULL),
  'vehicle_condition',jsonb_build_object('status','unknown','source',NULL,'evidence_revision',NULL,'text',NULL),
  'timing',jsonb_build_object('status','unknown','source',NULL,'evidence_revision',NULL,'earliest',NULL,'latest',NULL,'text',NULL),
  'location',jsonb_build_object('status','unknown','source',NULL,'evidence_revision',NULL,'type',NULL,'area',NULL),
  'constraints',jsonb_build_object('status','unknown','source',NULL,'evidence_revision',NULL,'items','[]'::jsonb)));
 IF vehicle_status<>'confirmed' THEN missing:=array_append(missing,'vehicle'); END IF;
 FOREACH field_name IN ARRAY ARRAY['service','vehicle_condition','timing','location','constraints'] LOOP
  IF doc->field_name->>'status'='unknown' THEN missing:=array_append(missing,field_name); END IF;
 END LOOP;
 SELECT count(*) INTO open_count FROM jsonb_array_elements(coalesce(q.open_questions,'[]'::jsonb)) x WHERE x->>'status'='open';
 IF open_count>0 THEN missing:=array_append(missing,'open_questions'); END IF;
 RETURN jsonb_build_object(
  'workflow_id',w.id,'channel',w.channel,'last_received_at',w.last_received_at,
  'identity',jsonb_build_object('state',w.state,'customer_id',c.id,'customer_name',c.name,'vehicle_id',CASE WHEN c.id IS NULL THEN NULL ELSE w.vehicle_id END,
   'vehicle_status',vehicle_status,'vehicle',CASE WHEN vehicle_status='confirmed' THEN jsonb_build_object('year',v.year,'make',v.make,'model',v.model,'color',v.color) ELSE NULL END,
   'evidence_revision',evidence),
  'revision',coalesce(q.revision,0),
  -- not_started: nothing recorded. needs_review: recorded, but no longer current.
  'review_state',CASE WHEN q.workflow_id IS NULL THEN 'not_started' WHEN cardinality(reasons)>0 THEN 'needs_review' ELSE q.review_state END,
  'recorded_review_state',q.review_state,
  'review_reasons',to_jsonb(reasons),
  'fields',doc,'open_questions',coalesce(q.open_questions,'[]'::jsonb),
  'missing',to_jsonb(missing),
  -- Complete means every answer is known and current. It is not a quote or booking decision.
  'completeness',CASE WHEN q.workflow_id IS NOT NULL AND cardinality(reasons)=0 AND cardinality(missing)=0 THEN 'complete' ELSE 'incomplete' END,
  'updated_at',q.updated_at,
  'updated_by',CASE WHEN actor.command_id IS NULL THEN NULL ELSE jsonb_build_object('actor_id',actor.actor_id,'label',actor.actor_label,'role',actor.actor_role) END);
END $$;

CREATE FUNCTION public.read_lead_qualification(p_shop uuid,p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR public.lead_qualification_role(p_shop,false) IS NULL THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 result:=public.lead_qualification_snapshot(p_shop,p_workflow);
 IF result IS NULL THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 RETURN result || jsonb_build_object('can_update',public.lead_qualification_role(p_shop,true) IS NOT NULL);
END $$;

-- Linked workflows, plus any that already carry a qualification, newest activity first.
CREATE FUNCTION public.list_lead_qualifications(p_shop uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE items jsonb;
BEGIN
 IF auth.uid() IS NULL OR public.lead_qualification_role(p_shop,false) IS NULL THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(s.snapshot - 'fields' - 'open_questions' ORDER BY s.activity DESC,s.id DESC),'[]'::jsonb) INTO items FROM (
  SELECT w.id,greatest(w.updated_at,coalesce(q.updated_at,w.updated_at)) AS activity,public.lead_qualification_snapshot(p_shop,w.id) AS snapshot
  FROM public.lead_workflows w LEFT JOIN public.lead_qualifications q ON q.shop_id=w.shop_id AND q.workflow_id=w.id
  WHERE w.shop_id=p_shop AND (w.state='identity_linked' OR q.workflow_id IS NOT NULL)
  ORDER BY activity DESC,w.id DESC LIMIT 21 OFFSET p_offset
 ) s;
 RETURN jsonb_build_object('items',items,'can_update',public.lead_qualification_role(p_shop,true) IS NOT NULL);
END $$;

CREATE FUNCTION public.read_lead_qualification_history(p_shop uuid,p_workflow uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE items jsonb; current_revision integer;
BEGIN
 IF auth.uid() IS NULL OR public.lead_qualification_role(p_shop,false) IS NULL THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow) THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO current_revision FROM public.lead_qualification_revisions WHERE shop_id=p_shop AND workflow_id=p_workflow;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.revision DESC),'[]'::jsonb) INTO items FROM (
  SELECT revision,review_state,actor_id,actor_role,actor_label,created_at,fields,open_questions,reviewed_customer_id,reviewed_vehicle_id,reviewed_evidence_revision
  FROM public.lead_qualification_revisions WHERE shop_id=p_shop AND workflow_id=p_workflow ORDER BY revision DESC LIMIT 21 OFFSET p_offset
 ) r;
 RETURN jsonb_build_object('revision',current_revision,'items',items);
END $$;

-- Full-document replace bound to what the reviewer saw. Authorization, validation,
-- the record and its audit row commit together or not at all.
CREATE FUNCTION public.update_lead_qualification(
 p_shop uuid,p_workflow uuid,p_command uuid,p_revision integer,p_customer uuid,p_vehicle uuid,
 p_review_state text,p_fields jsonb,p_open_questions jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE reviewer text; w public.lead_workflows; q public.lead_qualifications; v public.vehicles;
 previous public.lead_qualification_revisions; binding jsonb; invalid text; evidence integer; current_revision integer; field_name text;
BEGIN
 -- Lock order shared with membership changes and intake reviews: shop, workflow,
 -- then customer, then vehicle.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 reviewer:=public.lead_qualification_role(p_shop,true);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_workflow IS NULL OR p_customer IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>=2147483647 THEN
  RAISE EXCEPTION 'Invalid qualification' USING ERRCODE='22023',DETAIL='command'; END IF;
 IF p_review_state IS NULL OR p_review_state NOT IN ('in_progress','reviewed') THEN
  RAISE EXCEPTION 'Invalid qualification' USING ERRCODE='22023',DETAIL='review_state'; END IF;
 invalid:=public.lead_qualification_invalid_path(p_fields,p_open_questions);
 IF invalid IS NOT NULL THEN RAISE EXCEPTION 'Invalid qualification' USING ERRCODE='22023',DETAIL=invalid; END IF;
 binding:=jsonb_build_object('workflow_id',p_workflow,'reviewed_revision',p_revision,'customer_id',p_customer,'vehicle_id',p_vehicle,
  'review_state',p_review_state,'fields',p_fields,'open_questions',p_open_questions);
 SELECT * INTO previous FROM public.lead_qualification_revisions WHERE command_id=p_command;
 IF previous.command_id IS NOT NULL THEN
  IF previous.shop_id IS DISTINCT FROM p_shop OR previous.workflow_id IS DISTINCT FROM p_workflow
   OR previous.actor_id IS DISTINCT FROM auth.uid() OR previous.binding IS DISTINCT FROM binding THEN
   RAISE EXCEPTION 'Command conflict' USING ERRCODE='PT409',DETAIL='command_conflict'; END IF;
  RETURN public.lead_qualification_snapshot(p_shop,p_workflow) || jsonb_build_object('status','already_recorded','can_update',true);
 END IF;
 SELECT * INTO w FROM public.lead_workflows WHERE shop_id=p_shop AND id=p_workflow FOR UPDATE;
 IF w.id IS NULL THEN RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.customers WHERE shop_id=p_shop AND id=p_customer FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501',DETAIL='customer_unavailable'; END IF;
 IF p_vehicle IS NOT NULL THEN
  SELECT * INTO v FROM public.vehicles WHERE shop_id=p_shop AND customer_id=p_customer AND id=p_vehicle FOR SHARE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Vehicle unavailable' USING ERRCODE='42501',DETAIL='vehicle_unavailable'; END IF;
 END IF;
 -- Unresolved intake stays in identity review; qualification never resolves a person.
 IF w.state<>'identity_linked' OR w.customer_id IS NULL THEN
  RAISE EXCEPTION 'Identity review required' USING ERRCODE='PT409',DETAIL='identity_review_required'; END IF;
 IF w.customer_id IS DISTINCT FROM p_customer THEN RAISE EXCEPTION 'Customer changed' USING ERRCODE='PT409',DETAIL='customer_changed'; END IF;
 IF w.vehicle_id IS DISTINCT FROM p_vehicle OR (p_vehicle IS NOT NULL AND w.vehicle_snapshot IS DISTINCT FROM
  jsonb_build_object('id',v.id,'customer_id',v.customer_id,'year',v.year,'make',v.make,'model',v.model,'color',v.color,'plate',v.plate,'updated_at',v.updated_at)) THEN
  RAISE EXCEPTION 'Vehicle changed' USING ERRCODE='PT409',DETAIL='vehicle_changed'; END IF;
 IF p_fields->'service'->>'service_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.services WHERE shop_id=p_shop AND id=(p_fields->'service'->>'service_id')::uuid) THEN
  RAISE EXCEPTION 'Service unavailable' USING ERRCODE='42501',DETAIL='service_unavailable'; END IF;
 -- Intake provenance must point at a real submission on this workflow.
 FOREACH field_name IN ARRAY ARRAY['service','vehicle_condition','timing','location','constraints'] LOOP
  IF p_fields->field_name->>'evidence_revision' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.lead_workflow_transitions t
   WHERE t.shop_id=p_shop AND t.workflow_id=p_workflow AND t.envelope_id IS NOT NULL AND t.revision=(p_fields->field_name->>'evidence_revision')::integer) THEN
   RAISE EXCEPTION 'Invalid qualification' USING ERRCODE='22023',DETAIL='fields.'||field_name||'.evidence_revision'; END IF;
 END LOOP;
 SELECT * INTO q FROM public.lead_qualifications WHERE shop_id=p_shop AND workflow_id=p_workflow FOR UPDATE;
 current_revision:=coalesce(q.revision,0);
 IF current_revision<>p_revision THEN RAISE EXCEPTION 'Qualification changed; refresh required' USING ERRCODE='PT409',DETAIL='revision_conflict'; END IF;
 SELECT max(t.revision) INTO evidence FROM public.lead_workflow_transitions t WHERE t.shop_id=p_shop AND t.workflow_id=p_workflow AND t.envelope_id IS NOT NULL;
 INSERT INTO public.lead_qualifications(shop_id,workflow_id,revision,review_state,fields,open_questions,reviewed_customer_id,reviewed_vehicle_id,reviewed_evidence_revision,updated_by)
 VALUES(p_shop,p_workflow,1,p_review_state,p_fields,p_open_questions,p_customer,p_vehicle,evidence,auth.uid())
 ON CONFLICT(shop_id,workflow_id) DO UPDATE SET revision=current_revision+1,review_state=EXCLUDED.review_state,fields=EXCLUDED.fields,
  open_questions=EXCLUDED.open_questions,reviewed_customer_id=EXCLUDED.reviewed_customer_id,reviewed_vehicle_id=EXCLUDED.reviewed_vehicle_id,
  reviewed_evidence_revision=EXCLUDED.reviewed_evidence_revision,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp();
 INSERT INTO public.lead_qualification_revisions(command_id,shop_id,workflow_id,revision,actor_id,actor_role,actor_label,review_state,fields,open_questions,reviewed_customer_id,reviewed_vehicle_id,reviewed_evidence_revision,binding)
 VALUES(p_command,p_shop,p_workflow,current_revision+1,auth.uid(),reviewer,
  (SELECT display_name FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid()),
  p_review_state,p_fields,p_open_questions,p_customer,p_vehicle,evidence,binding);
 RETURN public.lead_qualification_snapshot(p_shop,p_workflow) || jsonb_build_object('status','recorded','can_update',true);
END $$;

REVOKE ALL ON FUNCTION public.lead_qualification_text_ok(jsonb,integer,boolean),public.lead_qualification_invalid_path(jsonb,jsonb),
 public.lead_qualification_role(uuid,boolean),public.lead_qualification_snapshot(uuid,uuid),
 public.read_lead_qualification(uuid,uuid),public.list_lead_qualifications(uuid,integer),public.read_lead_qualification_history(uuid,uuid,integer),
 public.update_lead_qualification(uuid,uuid,uuid,integer,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_lead_qualification(uuid,uuid),public.list_lead_qualifications(uuid,integer),
 public.read_lead_qualification_history(uuid,uuid,integer),
 public.update_lead_qualification(uuid,uuid,uuid,integer,uuid,uuid,text,jsonb,jsonb) TO authenticated;
COMMIT;
