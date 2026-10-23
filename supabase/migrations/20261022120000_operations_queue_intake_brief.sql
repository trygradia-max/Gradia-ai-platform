BEGIN;

-- Extend the read-only operations projection across existing durable intake and
-- pending-action records. No source row or lifecycle is changed. The mixed-source
-- cursor includes source kind so equal timestamps remain stable.
DROP FUNCTION public.list_operations_queue(uuid,timestamptz,uuid,integer);

CREATE FUNCTION public.list_operations_queue(
 p_shop uuid,
 p_before_observed_at timestamptz DEFAULT NULL,
 p_before_source_kind text DEFAULT NULL,
 p_before_source_id uuid DEFAULT NULL,
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
  OR ((p_before_observed_at IS NULL)<>(p_before_source_kind IS NULL))
  OR ((p_before_observed_at IS NULL)<>(p_before_source_id IS NULL))
  OR (p_before_source_kind IS NOT NULL AND p_before_source_kind NOT IN ('pending_action','intake_workflow')) THEN
  RAISE EXCEPTION 'Invalid operations queue page' USING ERRCODE='22023';
 END IF;

 SELECT m.* INTO viewer
 FROM public.shop_memberships m
 JOIN public.shops s ON s.id=m.shop_id
 WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
  AND ((m.role='owner' AND s.owner_id=m.user_id)
   OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities)
    AND m.capabilities && ARRAY['crm.read','approvals.messages','delivery.reconcile']::text[]));
 IF viewer.id IS NULL THEN
  RAISE EXCEPTION 'Operations queue unavailable' USING ERRCODE='42501';
 END IF;

 WITH candidates AS (
  SELECT 'pending_action'::text AS source_kind,a.id AS source_id,a.shop_id,
   a.created_at AS observed_at,a.action_type::text AS action_type,
   a.status::text AS action_status,a.result_id,
   CASE WHEN spent.action_id IS NULL THEN 'unspent'
        WHEN spent.completed_at IS NULL THEN 'claimed'
        ELSE 'provider_accepted' END AS delivery_state,
   spent.claimed_at,spent.completed_at,
   EXISTS(
    SELECT 1 FROM public.interactions i
    WHERE i.shop_id=a.shop_id AND i.role='gradia' AND i.channel IN ('sms','email')
     AND i.metadata->>'pending_action_id'=a.id::text
     AND jsonb_typeof(i.metadata->'twilio_status_conflict')='object'
   ) AS delivery_conflict,
   CASE
    WHEN jsonb_typeof(a.payload->'qualification')='object'
     AND a.payload->'qualification'->>'workflow_id' ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    THEN (a.payload->'qualification'->>'workflow_id')::uuid
    ELSE NULL
   END AS linked_workflow_id,
   NULL::integer AS intake_revision
  FROM public.pending_actions a
  LEFT JOIN public.service_proof_consumptions spent
   ON spent.shop_id=a.shop_id AND spent.action_id=a.id
  WHERE a.shop_id=p_shop
   AND (
    a.status::text IN ('pending','edit_requested')
    OR (a.status::text='approved' AND a.result_id IS NULL)
    OR (spent.action_id IS NOT NULL AND
     (spent.completed_at IS NULL OR a.result_id IS NULL OR a.status::text<>'approved'))
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
      (viewer.capabilities @> ARRAY['crm.read','approvals.messages']::text[]
       AND a.status::text IN ('pending','edit_requested')
       AND spent.action_id IS NULL
       AND NOT EXISTS(
        SELECT 1 FROM public.interactions i
        WHERE i.shop_id=a.shop_id AND i.role='gradia' AND i.channel IN ('sms','email')
         AND i.metadata->>'pending_action_id'=a.id::text
         AND jsonb_typeof(i.metadata->'twilio_status_conflict')='object'
       ))
      OR (viewer.capabilities @> ARRAY['crm.read','delivery.reconcile']::text[] AND (
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

  UNION ALL

  SELECT 'intake_workflow'::text,w.id,w.shop_id,w.last_received_at,
   NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::timestamptz,NULL::timestamptz,
   NULL::boolean,w.id,w.revision
  FROM public.lead_workflows w
  WHERE w.shop_id=p_shop AND w.handoff_pending
   AND (viewer.role='owner' OR viewer.capabilities @> ARRAY['crm.read']::text[])
 ), page AS (
  SELECT * FROM candidates c
  WHERE p_before_observed_at IS NULL
   OR c.observed_at<p_before_observed_at
   OR (c.observed_at=p_before_observed_at AND c.source_kind<p_before_source_kind)
   OR (c.observed_at=p_before_observed_at AND c.source_kind=p_before_source_kind
    AND c.source_id<p_before_source_id)
  ORDER BY c.observed_at DESC,c.source_kind DESC,c.source_id DESC
  LIMIT p_limit+1
 )
 SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY observed_at DESC,source_kind DESC,source_id DESC),'[]')
 INTO items FROM page;
 RETURN jsonb_build_object('viewer_role',viewer.role,'items',items);
END $$;

REVOKE ALL ON FUNCTION public.list_operations_queue(uuid,timestamptz,text,uuid,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_operations_queue(uuid,timestamptz,text,uuid,integer)
 TO authenticated;

COMMIT;
