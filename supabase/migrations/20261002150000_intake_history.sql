BEGIN;
-- Read-only history, including completed identity decisions. No new table grants.
CREATE FUNCTION public.read_lead_intake_history(
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
  'customer_id',w.customer_id,
  'total',(SELECT count(*) FROM public.lead_workflow_transitions WHERE shop_id=p_shop AND workflow_id=w.id),
  'items',coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.revision),'[]'::jsonb)
 ) INTO result FROM (
  SELECT t.revision,t.reason,t.received_at,t.created_at AS recorded_at,t.actor_id,
   CASE WHEN e.id IS NOT NULL THEN (SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
    FROM jsonb_each(e.payload) WHERE key IN ('display_name','phone','email','vehicle_text','service_text','message')) ELSE NULL END AS payload,
   CASE WHEN t.reason='identity_confirmed' THEN jsonb_build_object(
    'id',t.decision->'customer_id','name',t.decision->'snapshot'->'name',
    'phone',t.decision->'snapshot'->'phone','email',t.decision->'snapshot'->'email'
   ) ELSE NULL END AS reviewed_customer
  FROM public.lead_workflow_transitions t
  LEFT JOIN public.lead_intake_envelopes e ON e.id=t.envelope_id AND e.shop_id=t.shop_id AND e.workflow_id=t.workflow_id
  WHERE t.shop_id=p_shop AND t.workflow_id=w.id
  ORDER BY t.revision LIMIT p_limit OFFSET p_offset
 ) q;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_lead_intake_history(uuid,uuid,integer,integer,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_lead_intake_history(uuid,uuid,integer,integer,integer) TO authenticated;
COMMIT;
