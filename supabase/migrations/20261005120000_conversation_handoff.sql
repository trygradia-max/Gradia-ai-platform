BEGIN;
-- Operational metadata only. interactions remains the message store.
CREATE TABLE public.conversation_work (
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('sms','email','voice')),
 assignee_id uuid, state text NOT NULL DEFAULT 'needs_reply' CHECK(state IN ('needs_reply','held','completed')),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000), revision integer NOT NULL DEFAULT 1,
 through_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(shop_id,customer_id,channel),
 FOREIGN KEY(shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE CASCADE,
 FOREIGN KEY(shop_id,assignee_id) REFERENCES public.shop_memberships(shop_id,id) ON DELETE SET NULL(assignee_id)
);
CREATE TABLE public.conversation_reads (
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('sms','email','voice')),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 seen_at timestamptz NOT NULL, seen_id uuid NOT NULL, acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(shop_id,customer_id,channel,user_id),
 FOREIGN KEY(shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE CASCADE
);
CREATE TABLE public.conversation_audit (
 command_id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL, actor_id uuid NOT NULL, channel text NOT NULL,
 operation text NOT NULL, binding jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.conversation_notifications (
 id uuid PRIMARY KEY REFERENCES public.conversation_audit(command_id) ON DELETE CASCADE,
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL, recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 channel text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 email_state text NOT NULL DEFAULT 'disabled' CHECK(email_state='disabled'),
 FOREIGN KEY(shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE CASCADE
);
ALTER TABLE public.conversation_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_work,public.conversation_reads,public.conversation_audit,public.conversation_notifications FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.conversation_allowed(p_shop uuid,p_customer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active)
 AND EXISTS(SELECT 1 FROM public.customers WHERE id=p_customer AND shop_id=p_shop)
 AND public.team_can_read(p_shop,p_customer);
$$;
REVOKE ALL ON FUNCTION public.conversation_allowed(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.list_whisper_threads(p_shop uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active) THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC,q.id DESC),'[]') INTO result FROM (
  SELECT i.id,i.customer_id,c.name AS customer_name,i.channel::text AS channel,left(i.content,160) AS preview,i.created_at,
   EXISTS(SELECT 1 FROM public.interactions u WHERE u.shop_id=p_shop AND u.customer_id=i.customer_id AND u.channel=i.channel AND u.role='customer'
    AND (u.created_at,u.id)>(coalesce(r.seen_at,'-infinity'),coalesce(r.seen_id,'00000000-0000-0000-0000-000000000000'))) AS unread,
   CASE WHEN EXISTS(SELECT 1 FROM public.pending_actions a WHERE i.channel::text IN ('sms','email') AND a.shop_id=p_shop AND a.payload->>'customer_id'=i.customer_id::text AND a.action_type::text=CASE i.channel::text WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND a.status='approved' AND a.result_id IS NULL) THEN 'held'
    WHEN EXISTS(SELECT 1 FROM public.pending_actions a WHERE i.channel::text IN ('sms','email') AND a.shop_id=p_shop AND a.payload->>'customer_id'=i.customer_id::text AND a.action_type::text=CASE i.channel::text WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND a.status IN ('pending','edit_requested')) THEN 'awaiting_approval'
    WHEN w.state='held' THEN 'held' WHEN w.through_id=i.id THEN w.state ELSE 'needs_reply' END AS state,
   coalesce(m.display_name,'Owner fallback') AS assignee,
   EXISTS(SELECT 1 FROM public.conversation_notifications n WHERE n.shop_id=p_shop AND n.customer_id=i.customer_id
    AND n.channel=i.channel::text AND n.recipient_id=auth.uid() AND n.created_at>coalesce(r.acknowledged_at,'-infinity')) AS notified
  FROM (SELECT DISTINCT ON(customer_id,channel) * FROM public.interactions
   WHERE shop_id=p_shop AND customer_id IS NOT NULL AND channel::text IN ('sms','email','voice')
   AND public.conversation_allowed(p_shop,customer_id)
   ORDER BY customer_id,channel,created_at DESC,id DESC) i
  JOIN public.customers c ON c.shop_id=p_shop AND c.id=i.customer_id
  LEFT JOIN public.conversation_work w ON w.shop_id=p_shop AND w.customer_id=i.customer_id AND w.channel=i.channel::text
  LEFT JOIN public.shop_memberships m ON m.shop_id=p_shop AND m.id=w.assignee_id AND m.active AND (m.role='owner' OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities)))
  LEFT JOIN public.conversation_reads r ON r.shop_id=p_shop AND r.customer_id=i.customer_id AND r.channel=i.channel::text AND r.user_id=auth.uid()
  ORDER BY i.created_at DESC,i.id DESC LIMIT 21 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('items',result,'unidentified',CASE WHEN public.team_is_owner(p_shop) THEN (SELECT count(*) FROM public.interactions WHERE shop_id=p_shop AND customer_id IS NULL AND channel::text IN ('sms','email','voice')) ELSE 0 END,
 'notifications',(SELECT count(*) FROM public.conversation_notifications n WHERE n.shop_id=p_shop AND n.recipient_id=auth.uid() AND public.conversation_allowed(p_shop,n.customer_id)
 AND NOT EXISTS(SELECT 1 FROM public.conversation_reads r WHERE r.shop_id=n.shop_id AND r.customer_id=n.customer_id AND r.channel=n.channel AND r.user_id=auth.uid() AND r.acknowledged_at>=n.created_at)));
END $$;

CREATE FUNCTION public.read_whisper_thread(p_shop uuid,p_customer uuid,p_channel text,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE latest uuid; w public.conversation_work; result jsonb;
BEGIN
 IF NOT public.conversation_allowed(p_shop,p_customer) THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501'; END IF;
 IF p_channel IS NULL OR p_channel NOT IN ('sms','email','voice') OR p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT id INTO latest FROM public.interactions WHERE shop_id=p_shop AND customer_id=p_customer AND channel::text=p_channel ORDER BY created_at DESC,id DESC LIMIT 1;
 IF latest IS NULL THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO w FROM public.conversation_work WHERE shop_id=p_shop AND customer_id=p_customer AND channel=p_channel;
 SELECT jsonb_build_object('latest_id',latest,'revision',coalesce(w.revision,0),'state',CASE WHEN p_channel IN ('sms','email') AND EXISTS(SELECT 1 FROM public.pending_actions a WHERE a.shop_id=p_shop AND a.payload->>'customer_id'=p_customer::text AND a.action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND a.status='approved' AND a.result_id IS NULL) THEN 'held' WHEN p_channel IN ('sms','email') AND EXISTS(SELECT 1 FROM public.pending_actions a WHERE a.shop_id=p_shop AND a.payload->>'customer_id'=p_customer::text AND a.action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND a.status IN ('pending','edit_requested')) THEN 'awaiting_approval' WHEN w.state='held' THEN 'held' WHEN w.through_id=latest THEN w.state ELSE 'needs_reply' END,'reason',coalesce(w.reason,''),'assignee_id',w.assignee_id,
  'can_manage',public.team_has(p_shop,'assignments.manage'),'can_reply',public.team_is_owner(p_shop),'customer_id',p_customer,'channel',p_channel,
  'customer',(SELECT jsonb_build_object('name',name,'phone',phone,'email',email) FROM public.customers WHERE shop_id=p_shop AND id=p_customer),
  'items',coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC,q.id DESC),'[]'),
  'members',CASE WHEN public.team_has(p_shop,'assignments.manage') THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name)),'[]') FROM public.shop_memberships WHERE shop_id=p_shop AND active AND (role='owner' OR (role='manager' AND 'crm.read'=ANY(capabilities)))) ELSE '[]'::jsonb END,
  'intakes',CASE WHEN public.team_has(p_shop,'crm.read') THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'vehicle_id',vehicle_id)),'[]') FROM public.lead_workflows WHERE shop_id=p_shop AND customer_id=p_customer) ELSE '[]'::jsonb END,
  'actions',CASE WHEN p_channel IN ('sms','email') AND public.team_is_owner(p_shop) THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'result_id',result_id)),'[]') FROM public.pending_actions WHERE shop_id=p_shop AND payload->>'customer_id'=p_customer::text AND action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END) ELSE '[]'::jsonb END
 ) INTO result FROM (SELECT id,role::text AS role,content,created_at,occurred_at FROM public.interactions WHERE shop_id=p_shop AND customer_id=p_customer AND channel::text=p_channel ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET p_offset) q;
 RETURN result;
END $$;

CREATE FUNCTION public.whisper_command(p_shop uuid,p_customer uuid,p_channel text,p_command uuid,p_latest uuid,p_revision integer,p_operation text,p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE latest public.interactions; w public.conversation_work; prior public.conversation_audit; binding jsonb; c public.customers; member public.shop_memberships; recipient uuid; action_payload jsonb;
BEGIN
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF NOT public.conversation_allowed(p_shop,p_customer) THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501'; END IF;
 IF p_channel IS NULL OR p_channel NOT IN ('sms','email','voice') OR p_command IS NULL OR p_latest IS NULL OR p_revision IS NULL OR p_revision<0 OR p_operation IS NULL OR p_operation NOT IN ('read','handoff','reply') OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023'; END IF;
 IF p_operation='handoff' AND NOT public.team_has(p_shop,'assignments.manage') OR p_operation='reply' AND NOT public.team_is_owner(p_shop) THEN RAISE EXCEPTION 'Operation unavailable' USING ERRCODE='42501'; END IF;
 -- RPC callers do not have to use the UI: enforce the same payload boundary here.
 IF (p_operation='read' AND p_payload<>'{}'::jsonb)
 OR (p_operation='handoff' AND ((p_payload-ARRAY['state','reason','assignee_id'])<>'{}'::jsonb
  OR jsonb_typeof(p_payload->'state') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string'
  OR coalesce(jsonb_typeof(p_payload->'assignee_id'),'missing') NOT IN ('string','null')))
 OR (p_operation='reply' AND ((p_payload-ARRAY['body','subject','destination'])<>'{}'::jsonb
  OR jsonb_typeof(p_payload->'body') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_payload->'subject') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_payload->'destination') IS DISTINCT FROM 'string'))
 THEN RAISE EXCEPTION 'Invalid command payload' USING ERRCODE='22023'; END IF;
 binding:=jsonb_build_object('latest',p_latest,'revision',p_revision,'payload',p_payload);
 SELECT * INTO prior FROM public.conversation_audit WHERE command_id=p_command;
 IF prior.command_id IS NOT NULL THEN
  IF prior.shop_id<>p_shop OR prior.customer_id<>p_customer OR prior.channel<>p_channel OR prior.actor_id<>auth.uid() OR prior.operation<>p_operation OR prior.binding IS DISTINCT FROM binding THEN RAISE EXCEPTION 'Command conflict' USING ERRCODE='PT409'; END IF;
  RETURN p_command;
 END IF;
 SELECT * INTO latest FROM public.interactions WHERE shop_id=p_shop AND customer_id=p_customer AND channel::text=p_channel ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO w FROM public.conversation_work WHERE shop_id=p_shop AND customer_id=p_customer AND channel=p_channel FOR UPDATE;
 IF latest.id IS NULL OR latest.id<>p_latest OR coalesce(w.revision,0)<>p_revision THEN RAISE EXCEPTION 'Conversation changed; refresh' USING ERRCODE='PT409'; END IF;
 IF p_operation='read' THEN
  INSERT INTO public.conversation_reads VALUES(p_shop,p_customer,p_channel,auth.uid(),latest.created_at,latest.id,clock_timestamp())
  ON CONFLICT(shop_id,customer_id,channel,user_id) DO UPDATE SET seen_at=EXCLUDED.seen_at,seen_id=EXCLUDED.seen_id,acknowledged_at=EXCLUDED.acknowledged_at;
 ELSIF p_operation='handoff' THEN
  IF p_payload->>'state' IS NULL OR p_payload->>'state' NOT IN ('needs_reply','held','completed') OR length(coalesce(p_payload->>'reason',''))>1000 OR (p_payload->>'state'='held' AND length(btrim(coalesce(p_payload->>'reason','')))=0) THEN RAISE EXCEPTION 'Invalid handoff' USING ERRCODE='22023'; END IF;
  IF p_payload->>'assignee_id' IS NOT NULL THEN
   SELECT * INTO member FROM public.shop_memberships WHERE shop_id=p_shop AND id=(p_payload->>'assignee_id')::uuid AND active AND (role='owner' OR (role='manager' AND 'crm.read'=ANY(capabilities))) FOR SHARE;
   IF member.id IS NULL THEN RAISE EXCEPTION 'Assignee unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  INSERT INTO public.conversation_work(shop_id,customer_id,channel,assignee_id,state,reason,revision,through_id)
  VALUES(p_shop,p_customer,p_channel,member.id,p_payload->>'state',coalesce(p_payload->>'reason',''),1,p_latest)
  ON CONFLICT(shop_id,customer_id,channel) DO UPDATE SET assignee_id=EXCLUDED.assignee_id,state=EXCLUDED.state,reason=EXCLUDED.reason,revision=conversation_work.revision+1,through_id=p_latest,updated_at=clock_timestamp();
 ELSE
  IF p_channel NOT IN ('sms','email') OR length(btrim(coalesce(p_payload->>'body',''))) NOT BETWEEN 1 AND (CASE WHEN p_channel='sms' THEN 1600 ELSE 8000 END) THEN RAISE EXCEPTION 'Invalid reply' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=p_customer FOR SHARE;
  IF (p_channel='sms' AND (c.phone IS NULL OR c.phone IS DISTINCT FROM p_payload->>'destination')) OR (p_channel='email' AND (c.email IS NULL OR c.email IS DISTINCT FROM p_payload->>'destination' OR length(btrim(coalesce(p_payload->>'subject',''))) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'Recipient changed' USING ERRCODE='PT409'; END IF;
  action_payload:=jsonb_build_object('category','marketing','customer_id',c.id,'customer_name',c.name,'body',p_payload->>'body','source','whisper_inbox','conversation_interaction_id',p_latest);
  IF p_channel='sms' THEN action_payload:=action_payload||jsonb_build_object('to_phone',c.phone); ELSE action_payload:=action_payload||jsonb_build_object('to_email',c.email,'subject',p_payload->>'subject'); END IF;
  INSERT INTO public.pending_actions(id,shop_id,requested_by,action_type,payload) VALUES(p_command,p_shop,auth.uid(),CASE WHEN p_channel='sms' THEN 'send_sms'::public.pending_action_type ELSE 'send_email'::public.pending_action_type END,action_payload);
 END IF;
 INSERT INTO public.conversation_audit VALUES(p_command,p_shop,p_customer,auth.uid(),p_channel,p_operation,binding,clock_timestamp());
 IF p_operation IN ('handoff','reply') THEN
  IF p_operation='reply' THEN
   SELECT * INTO member FROM public.shop_memberships WHERE shop_id=p_shop AND id=w.assignee_id AND active
    AND (role='owner' OR (role='manager' AND 'crm.read'=ANY(capabilities)));
  END IF;
  SELECT coalesce(member.user_id,owner_id) INTO recipient FROM public.shops WHERE id=p_shop;
  INSERT INTO public.conversation_notifications(id,shop_id,customer_id,recipient_id,channel) VALUES(p_command,p_shop,p_customer,recipient,p_channel);
 END IF;
 RETURN p_command;
END $$;
REVOKE ALL ON FUNCTION public.list_whisper_threads(uuid,integer),public.read_whisper_thread(uuid,uuid,text,integer),public.whisper_command(uuid,uuid,text,uuid,uuid,integer,text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.list_whisper_threads(uuid,integer),public.read_whisper_thread(uuid,uuid,text,integer),public.whisper_command(uuid,uuid,text,uuid,uuid,integer,text,jsonb) TO authenticated;
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
 -- Merge operational metadata conservatively: review again, unread for everyone.
 INSERT INTO public.conversation_work(shop_id,customer_id,channel,assignee_id,state,reason,revision,through_id)
 SELECT shop_id,p_winner,channel,NULL,'held','Customer merged; review conversation ownership and context.',revision+1,through_id FROM public.conversation_work WHERE shop_id=p_shop AND customer_id=p_loser
 ON CONFLICT(shop_id,customer_id,channel) DO UPDATE SET assignee_id=NULL,state='held',reason=EXCLUDED.reason,revision=conversation_work.revision+1,updated_at=clock_timestamp();
 UPDATE public.conversation_work SET state='held',reason='Customer merged; review conversation ownership and context.',assignee_id=NULL,revision=revision+1 WHERE shop_id=p_shop AND customer_id=p_winner;
 INSERT INTO public.conversation_reads(shop_id,customer_id,channel,user_id,seen_at,seen_id,acknowledged_at)
 SELECT shop_id,p_winner,channel,user_id,'-infinity','00000000-0000-0000-0000-000000000000','-infinity' FROM public.conversation_reads WHERE shop_id=p_shop AND customer_id=p_loser
 ON CONFLICT(shop_id,customer_id,channel,user_id) DO NOTHING;
 UPDATE public.conversation_reads SET seen_at='-infinity',seen_id='00000000-0000-0000-0000-000000000000',acknowledged_at='-infinity' WHERE shop_id=p_shop AND customer_id=p_winner;
 UPDATE public.conversation_notifications SET customer_id=p_winner WHERE shop_id=p_shop AND customer_id=p_loser;
 -- conversation_audit intentionally retains original customer references/bindings.
 DELETE FROM public.customers WHERE id=p_loser AND shop_id=p_shop;
 RETURN moved;
END $$;
COMMIT;
