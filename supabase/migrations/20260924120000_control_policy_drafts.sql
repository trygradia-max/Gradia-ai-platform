BEGIN;
-- Reviewable policy plans only. No production behavior or activation changes.
CREATE FUNCTION public.control_validate_draft(p_definition jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE k text; v jsonb; entry record; allowed text[];
BEGIN
 IF p_definition IS NULL OR jsonb_typeof(p_definition)<>'object' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_definition))<>9 OR NOT p_definition ?& ARRAY['enabled','workspaceDefault','workspaceCeiling','locationCeiling','connectorCeilings','actionGrants','roleCeilings','riskCeilings','exceptionCeilings'] THEN RETURN false; END IF;
 IF jsonb_typeof(p_definition->'enabled')<>'boolean' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['workspaceDefault','workspaceCeiling','locationCeiling'] LOOP
  v:=p_definition->k;
  IF v='null'::jsonb AND k<>'workspaceCeiling' THEN CONTINUE; END IF;
  IF jsonb_typeof(v)<>'string' OR NOT (v #>> '{}')=ANY(ARRAY['off','read','suggest','approval','autonomous']) THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['connectorCeilings','actionGrants','roleCeilings','riskCeilings','exceptionCeilings'] LOOP
  v:=p_definition->k;
  IF jsonb_typeof(v)<>'object' THEN RETURN false; END IF;
  allowed:=CASE k
   WHEN 'connectorCeilings' THEN ARRAY['crm','sms','email','voice','calendar','memory','internal','website','meta']
   WHEN 'actionGrants' THEN ARRAY['crm.read','history.read','menu.read','availability.read','draft.private','memory.propose','intake.capture','identity.deduplicate','identity.review','customer.merge','sms.reply','sms.qualify','sms.nurture','email.reply','email.qualify','email.nurture','voice.inbound','voice.outbound','quote.send','booking.create','quote.discount','booking.reschedule','booking.cancel','sms.confirm','sms.remind','sms.followup','email.confirm','email.remind','email.followup','crm.edit','assignment.change','pipeline.change','pipeline.mechanical','evidence.record','memory.publish.customer','memory.publish.shop','manager.notify','campaign.send']
   WHEN 'roleCeilings' THEN ARRAY['owner','manager','staff']
   WHEN 'riskCeilings' THEN ARRAY['routine','elevated','high']
   WHEN 'exceptionCeilings' THEN ARRAY['unknown_identity','stale_calendar','outside_hours','price_exception'] END;
  FOR entry IN SELECT * FROM jsonb_each(v) LOOP
   IF NOT entry.key=ANY(allowed) THEN RETURN false; END IF;
   IF entry.value='null'::jsonb THEN CONTINUE; END IF;
   IF jsonb_typeof(entry.value)<>'string' OR NOT (entry.value #>> '{}')=ANY(ARRAY['off','read','suggest','approval','autonomous']) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
CREATE TABLE public.control_policy_drafts (
 shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
 location_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 definition jsonb NOT NULL CHECK(public.control_validate_draft(definition)),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(shop_id,location_id) REFERENCES public.shop_locations(shop_id,id)
);
CREATE TABLE public.control_policy_history (
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>0),
 location_id uuid NOT NULL,
 definition jsonb NOT NULL CHECK(public.control_validate_draft(definition)),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,revision),
 FOREIGN KEY(shop_id,location_id) REFERENCES public.shop_locations(shop_id,id)
);
ALTER TABLE public.control_policy_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.control_policy_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.control_policy_drafts,public.control_policy_history FROM anon,authenticated;
GRANT SELECT ON public.control_policy_drafts,public.control_policy_history TO authenticated;
CREATE POLICY control_draft_owner_read ON public.control_policy_drafts FOR SELECT TO authenticated USING(public.team_is_owner(shop_id));
CREATE POLICY control_history_owner_read ON public.control_policy_history FOR SELECT TO authenticated USING(public.team_is_owner(shop_id));
CREATE FUNCTION public.control_initialize_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; initial jsonb:= '{"enabled":true,"workspaceDefault":null,"workspaceCeiling":"autonomous","locationCeiling":null,"connectorCeilings":{},"actionGrants":{},"roleCeilings":{},"riskCeilings":{},"exceptionCeilings":{}}';
BEGIN
 SELECT owner_id INTO actor FROM public.shops WHERE id=NEW.shop_id;
 INSERT INTO public.control_policy_drafts(shop_id,location_id,revision,definition,updated_by) VALUES(NEW.shop_id,NEW.id,1,initial,actor);
 INSERT INTO public.control_policy_history(shop_id,location_id,revision,definition,actor_id) VALUES(NEW.shop_id,NEW.id,1,initial,actor);
 RETURN NEW;
END $$;
-- Location bootstrap runs inside existing shop/membership creation transaction.
CREATE TRIGGER control_initialize_draft AFTER INSERT ON public.shop_locations FOR EACH ROW EXECUTE FUNCTION public.control_initialize_draft();
INSERT INTO public.control_policy_drafts(shop_id,location_id,revision,definition,updated_by)
 SELECT l.shop_id,l.id,1,'{"enabled":true,"workspaceDefault":null,"workspaceCeiling":"autonomous","locationCeiling":null,"connectorCeilings":{},"actionGrants":{},"roleCeilings":{},"riskCeilings":{},"exceptionCeilings":{}}'::jsonb,s.owner_id FROM public.shop_locations l JOIN public.shops s ON s.id=l.shop_id;
INSERT INTO public.control_policy_history(shop_id,location_id,revision,definition,actor_id)
 SELECT shop_id,location_id,revision,definition,updated_by FROM public.control_policy_drafts;
CREATE FUNCTION public.save_control_policy_draft(p_shop uuid,p_expected_revision integer,p_definition jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_draft public.control_policy_drafts; next_revision integer;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_is_owner(p_shop) THEN RAISE EXCEPTION 'Only the owner may change a policy draft' USING ERRCODE='42501'; END IF;
 IF NOT public.control_validate_draft(p_definition) THEN RAISE EXCEPTION 'Invalid policy draft' USING ERRCODE='22023'; END IF;
 SELECT * INTO current_draft FROM public.control_policy_drafts WHERE shop_id=p_shop FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy draft unavailable' USING ERRCODE='42501'; END IF;
 IF p_expected_revision IS DISTINCT FROM current_draft.revision THEN RAISE EXCEPTION 'Policy draft changed; reload before saving' USING ERRCODE='PT409'; END IF;
 -- A repeated save with identical content is idempotent at the same revision.
 IF current_draft.definition=p_definition THEN RETURN current_draft.revision; END IF;
 next_revision:=current_draft.revision+1;
 INSERT INTO public.control_policy_history(shop_id,location_id,revision,definition,actor_id)
 VALUES(p_shop,current_draft.location_id,next_revision,p_definition,auth.uid());
 UPDATE public.control_policy_drafts SET revision=next_revision,definition=p_definition,updated_by=auth.uid(),updated_at=clock_timestamp() WHERE shop_id=p_shop;
 RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION public.control_validate_draft(jsonb),public.control_initialize_draft(),public.save_control_policy_draft(uuid,integer,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_control_policy_draft(uuid,integer,jsonb) TO authenticated;
COMMIT;
