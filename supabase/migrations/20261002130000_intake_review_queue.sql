BEGIN;
-- Human review visibility only. No resolution, acknowledgement or delivery writes.
CREATE FUNCTION public.list_lead_intake_review(p_shop uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 20)
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
  SELECT w.id,w.channel,w.provider,w.state,w.revision,w.last_received_at,e.payload
  FROM public.lead_workflows w JOIN public.lead_intake_envelopes e
   ON e.shop_id=w.shop_id AND e.workflow_id=w.id AND e.id=w.last_envelope_id
  WHERE w.shop_id=p_shop AND w.handoff_pending
  ORDER BY w.last_received_at DESC,w.id DESC LIMIT p_limit OFFSET p_offset
 ) q;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.list_lead_intake_review(uuid,integer,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.list_lead_intake_review(uuid,integer,integer) TO authenticated;
COMMIT;
