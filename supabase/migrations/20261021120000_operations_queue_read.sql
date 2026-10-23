BEGIN;

-- Evidence-backed operations queue read. This is a projection over the existing
-- pending-action and delivery records, not a second task store or executor.
-- The function returns only the fields needed by the internal queue DTO.
CREATE FUNCTION public.list_operations_queue(
 p_shop uuid,
 p_before_created_at timestamptz DEFAULT NULL,
 p_before_id uuid DEFAULT NULL,
 p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 viewer public.shop_memberships;
 items jsonb;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'Operations queue unavailable' USING ERRCODE='42501';
 END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50
  OR ((p_before_created_at IS NULL)<>(p_before_id IS NULL)) THEN
  RAISE EXCEPTION 'Invalid operations queue page' USING ERRCODE='22023';
 END IF;

 SELECT m.* INTO viewer
 FROM public.shop_memberships m
 JOIN public.shops s ON s.id=m.shop_id
 WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
  AND ((m.role='owner' AND s.owner_id=m.user_id)
   OR (m.role='manager' AND m.capabilities && ARRAY['approvals.messages','delivery.reconcile']::text[]));
 IF viewer.id IS NULL THEN
  RAISE EXCEPTION 'Operations queue unavailable' USING ERRCODE='42501';
 END IF;

 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC,q.id DESC),'[]') INTO items
 FROM (
  SELECT a.id,a.shop_id,a.action_type::text AS action_type,a.status::text AS status,
   a.result_id,a.created_at,
   CASE WHEN spent.action_id IS NULL THEN 'unspent'
        WHEN spent.completed_at IS NULL THEN 'claimed'
        ELSE 'provider_accepted' END AS delivery_state,
   spent.claimed_at,spent.completed_at,
   EXISTS(
    SELECT 1 FROM public.interactions i
    WHERE i.shop_id=a.shop_id AND i.role='gradia' AND i.channel IN ('sms','email')
     AND i.metadata->>'pending_action_id'=a.id::text
     AND jsonb_typeof(i.metadata->'twilio_status_conflict')='object'
   ) AS delivery_conflict
  FROM public.pending_actions a
  LEFT JOIN public.service_proof_consumptions spent
   ON spent.shop_id=a.shop_id AND spent.action_id=a.id
  WHERE a.shop_id=p_shop
   AND (p_before_created_at IS NULL OR a.created_at<p_before_created_at
    OR (a.created_at=p_before_created_at AND a.id<p_before_id))
   AND (
    a.status::text IN ('pending','edit_requested')
    OR (a.status::text='approved' AND a.result_id IS NULL)
    OR spent.action_id IS NOT NULL
    OR EXISTS(
     SELECT 1 FROM public.interactions i
     WHERE i.shop_id=a.shop_id AND i.role='gradia' AND i.channel IN ('sms','email')
      AND i.metadata->>'pending_action_id'=a.id::text
      AND jsonb_typeof(i.metadata->'twilio_status_conflict')='object'
    )
   )
   AND (
    viewer.role='owner'
    OR (
     a.action_type::text IN ('send_sms','send_email')
     AND (
      ('approvals.messages'=ANY(viewer.capabilities)
       AND a.status::text IN ('pending','edit_requested')
       AND spent.action_id IS NULL
       AND NOT EXISTS(
        SELECT 1 FROM public.interactions i
        WHERE i.shop_id=a.shop_id AND i.role='gradia' AND i.channel IN ('sms','email')
         AND i.metadata->>'pending_action_id'=a.id::text
         AND jsonb_typeof(i.metadata->'twilio_status_conflict')='object'
       ))
      OR ('delivery.reconcile'=ANY(viewer.capabilities) AND (
       (spent.action_id IS NOT NULL AND
        (spent.completed_at IS NULL OR a.result_id IS NULL OR a.status::text<>'approved'))
       OR EXISTS(
        SELECT 1 FROM public.interactions i
        WHERE i.shop_id=a.shop_id AND i.role='gradia' AND i.channel IN ('sms','email')
         AND i.metadata->>'pending_action_id'=a.id::text
         AND jsonb_typeof(i.metadata->'twilio_status_conflict')='object'
       )
      ))
     )
    )
   )
  ORDER BY a.created_at DESC,a.id DESC
  LIMIT p_limit+1
 ) q;
 RETURN jsonb_build_object('viewer_role',viewer.role,'items',items);
END $$;

REVOKE ALL ON FUNCTION public.list_operations_queue(uuid,timestamptz,uuid,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_operations_queue(uuid,timestamptz,uuid,integer)
 TO authenticated;

COMMIT;
