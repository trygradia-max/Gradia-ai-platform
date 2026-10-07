BEGIN;
-- Resolve immutable Whisper command evidence, never a caller-selected latest thread.
CREATE FUNCTION public.whisper_reply_context(p_shop uuid,p_action uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.pending_actions; h public.conversation_audit; c public.customers; destination text; inbound public.interactions;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT (
  public.team_is_owner(p_shop) AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active)
 ) THEN RAISE EXCEPTION 'Reply review unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.pending_actions WHERE shop_id=p_shop AND id=p_action;
 IF a.id IS NULL OR a.action_type::text NOT IN ('send_sms','send_email') THEN RAISE EXCEPTION 'Message unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM public.conversation_audit WHERE command_id=p_action AND shop_id=p_shop AND operation='reply';
 IF h.command_id IS NULL THEN
  IF a.payload->>'source'='whisper_inbox' THEN RAISE EXCEPTION 'Conversation evidence unavailable' USING ERRCODE='42501'; END IF;
  RETURN NULL; -- A legacy producer; its existing purpose rules remain in force.
 END IF;
 SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=h.customer_id;
 destination:=public.canonical_contact_destination(h.channel,h.binding->'payload'->>'destination');
 IF c.id IS NULL OR h.channel NOT IN ('sms','email')
 OR a.action_type::text IS DISTINCT FROM (CASE h.channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END)
 OR a.payload->>'customer_id' IS DISTINCT FROM h.customer_id::text
 OR a.payload->>'conversation_interaction_id' IS DISTINCT FROM h.binding->>'latest'
 OR destination IS NULL
 OR destination IS DISTINCT FROM (CASE h.channel WHEN 'sms' THEN c.phone_canonical ELSE c.email_canonical END)
 OR destination IS DISTINCT FROM public.canonical_contact_destination(h.channel,CASE h.channel WHEN 'sms' THEN a.payload->>'to_phone' ELSE a.payload->>'to_email' END)
 THEN RAISE EXCEPTION 'Conversation binding changed; review required' USING ERRCODE='42501'; END IF;
 SELECT * INTO inbound FROM public.interactions WHERE shop_id=p_shop AND id=(h.binding->>'latest')::uuid AND customer_id=h.customer_id;
 IF inbound.id IS NULL OR inbound.channel::text IS DISTINCT FROM h.channel OR inbound.role::text IS DISTINCT FROM 'customer'
 OR inbound.metadata->>'direction' IS DISTINCT FROM 'inbound'
 OR (CASE h.channel WHEN 'sms' THEN inbound.metadata->>'from_phone' ELSE inbound.metadata->>'from_email' END) IS DISTINCT FROM destination
 OR inbound.created_at>clock_timestamp() OR inbound.created_at<clock_timestamp()-interval '48 hours'
 THEN RAISE EXCEPTION 'Recent inbound reply context unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('interaction_id',inbound.id,'customer_id',h.customer_id,'channel',h.channel,'destination',destination,'content',inbound.content,'recorded_at',inbound.created_at);
END $$;
REVOKE ALL ON FUNCTION public.whisper_reply_context(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.whisper_reply_context(uuid,uuid) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_whisper_threads(p_shop uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active) THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC,q.id DESC),'[]') INTO result FROM (
  SELECT i.id,i.customer_id,c.name AS customer_name,i.channel::text AS channel,left(i.content,160) AS preview,i.created_at,
   EXISTS(SELECT 1 FROM public.interactions u WHERE u.shop_id=p_shop AND u.customer_id=i.customer_id AND u.channel=i.channel AND u.role='customer'
    AND (u.created_at,u.id)>(coalesce(r.seen_at,'-infinity'),coalesce(r.seen_id,'00000000-0000-0000-0000-000000000000'))) AS unread,
   CASE WHEN EXISTS(SELECT 1 FROM public.pending_actions a WHERE i.channel::text IN ('sms','email') AND a.shop_id=p_shop AND a.payload->>'customer_id'=i.customer_id::text AND a.action_type::text=CASE i.channel::text WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND ((a.status='approved' AND a.result_id IS NULL) OR EXISTS(SELECT 1 FROM public.service_proof_consumptions spent WHERE spent.shop_id=p_shop AND spent.action_id=a.id AND (spent.completed_at IS NULL OR a.result_id IS NULL OR a.status<>'approved')))) THEN 'held'
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

CREATE OR REPLACE FUNCTION public.read_whisper_thread(p_shop uuid,p_customer uuid,p_channel text,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE latest uuid; w public.conversation_work; result jsonb;
BEGIN
 IF NOT public.conversation_allowed(p_shop,p_customer) THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501'; END IF;
 IF p_channel IS NULL OR p_channel NOT IN ('sms','email','voice') OR p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT id INTO latest FROM public.interactions WHERE shop_id=p_shop AND customer_id=p_customer AND channel::text=p_channel ORDER BY created_at DESC,id DESC LIMIT 1;
 IF latest IS NULL THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO w FROM public.conversation_work WHERE shop_id=p_shop AND customer_id=p_customer AND channel=p_channel;
 SELECT jsonb_build_object('latest_id',latest,'revision',coalesce(w.revision,0),'state',CASE WHEN p_channel IN ('sms','email') AND EXISTS(SELECT 1 FROM public.pending_actions a WHERE a.shop_id=p_shop AND a.payload->>'customer_id'=p_customer::text AND a.action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND ((a.status='approved' AND a.result_id IS NULL) OR EXISTS(SELECT 1 FROM public.service_proof_consumptions spent WHERE spent.shop_id=p_shop AND spent.action_id=a.id AND (spent.completed_at IS NULL OR a.result_id IS NULL OR a.status<>'approved')))) THEN 'held' WHEN p_channel IN ('sms','email') AND EXISTS(SELECT 1 FROM public.pending_actions a WHERE a.shop_id=p_shop AND a.payload->>'customer_id'=p_customer::text AND a.action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END AND a.status IN ('pending','edit_requested')) THEN 'awaiting_approval' WHEN w.state='held' THEN 'held' WHEN w.through_id=latest THEN w.state ELSE 'needs_reply' END,'reason',CASE WHEN p_channel IN ('sms','email') AND EXISTS(
   SELECT 1 FROM public.pending_actions a JOIN public.service_proof_consumptions spent ON spent.shop_id=a.shop_id AND spent.action_id=a.id
   WHERE a.shop_id=p_shop AND a.payload->>'customer_id'=p_customer::text
    AND a.action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END
    AND (spent.completed_at IS NULL OR a.result_id IS NULL OR a.status<>'approved'))
   THEN 'Execution has been claimed. Review delivery in Approvals; do not retry or create a replacement automatically.' ELSE coalesce(w.reason,'') END,'assignee_id',w.assignee_id,
  'can_manage',public.team_has(p_shop,'assignments.manage'),'can_reply',public.team_is_owner(p_shop),'customer_id',p_customer,'channel',p_channel,
  'customer',(SELECT jsonb_build_object('name',name,'phone',phone,'email',email) FROM public.customers WHERE shop_id=p_shop AND id=p_customer),
  'items',coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC,q.id DESC),'[]'),
  'members',CASE WHEN public.team_has(p_shop,'assignments.manage') THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name)),'[]') FROM public.shop_memberships WHERE shop_id=p_shop AND active AND (role='owner' OR (role='manager' AND 'crm.read'=ANY(capabilities)))) ELSE '[]'::jsonb END,
  'intakes',CASE WHEN public.team_has(p_shop,'crm.read') THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'vehicle_id',vehicle_id)),'[]') FROM public.lead_workflows WHERE shop_id=p_shop AND customer_id=p_customer) ELSE '[]'::jsonb END,
  'actions',CASE WHEN p_channel IN ('sms','email') AND public.team_is_owner(p_shop) THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'result_id',result_id)),'[]') FROM public.pending_actions WHERE shop_id=p_shop AND payload->>'customer_id'=p_customer::text AND action_type::text=CASE p_channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END) ELSE '[]'::jsonb END
 ) INTO result FROM (SELECT id,role::text AS role,content,created_at,occurred_at FROM public.interactions WHERE shop_id=p_shop AND customer_id=p_customer AND channel::text=p_channel ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET p_offset) q;
 RETURN result;
END $$;

COMMIT;
