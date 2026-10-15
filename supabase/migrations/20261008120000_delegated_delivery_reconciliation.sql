BEGIN;
-- First delegated manager operation: recording a human delivery assessment.
-- An explicit owner grant is required; membership or CRM read alone grants nothing.
-- Reviews remain evidence only: no proof release, resend, hold clearance or policy change.
DO $$
DECLARE target text; existing text; found integer;
BEGIN
 FOREACH target IN ARRAY ARRAY['shop_memberships','shop_invitations'] LOOP
  SELECT count(*),min(conname) INTO found,existing FROM pg_catalog.pg_constraint
  WHERE conrelid=('public.'||target)::regclass AND contype='c' AND pg_catalog.pg_get_constraintdef(oid) LIKE '%assignments.manage%';
  -- Refuse rather than guess when the reviewed constraint is not exactly as expected.
  IF found<>1 THEN RAISE EXCEPTION 'Unexpected capability constraints on %',target; END IF;
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target,existing);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (capabilities <@ ARRAY[''crm.read'',''notes.write'',''jobs.progress'',''assignments.manage'',''delivery.reconcile'']::text[])',target,target||'_capabilities_known');
  -- A reviewer must be able to read the customer evidence being assessed.
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (NOT (''delivery.reconcile''=ANY(capabilities)) OR ''crm.read''=ANY(capabilities))',target,target||'_delivery_review_needs_read');
 END LOOP;
END $$;

-- Every earlier review was recorded by the owner-only command.
ALTER TABLE public.delivery_reconciliations ADD COLUMN actor_role text NOT NULL DEFAULT 'owner' CHECK (actor_role IN ('owner','manager'));
ALTER TABLE public.delivery_reconciliations ALTER COLUMN actor_role DROP DEFAULT;

-- Private authority helper. Returns the caller's live reviewing role or NULL.
CREATE FUNCTION public.delivery_review_role(p_shop uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.role FROM public.shop_memberships m JOIN public.shops s ON s.id=m.shop_id
 WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active
 AND ((m.role='owner' AND s.owner_id=m.user_id)
  OR (m.role='manager' AND m.capabilities @> ARRAY['crm.read','delivery.reconcile']::text[]));
$$;
REVOKE ALL ON FUNCTION public.delivery_review_role(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_delivery_reconciliation(p_shop uuid,p_action uuid,p_command uuid,p_revision integer,p_completed_at timestamptz,p_outcome text,p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE claim public.service_proof_consumptions; previous public.delivery_reconciliations; current_revision integer; reviewer text;
BEGIN
 -- Session-only. Lock the shop before checking live authority, so a concurrent
 -- revocation or grant removal serializes with this write.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 reviewer:=public.delivery_review_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>=2147483647 OR p_outcome IS NULL
 OR p_outcome NOT IN ('delivered','not_delivered','unknown') OR p_note IS NULL
 OR char_length(p_note) NOT BETWEEN 10 AND 2000 OR p_note IS DISTINCT FROM btrim(p_note)
 OR regexp_replace(p_note,E'[\n\r\t]','','g') ~ '[[:cntrl:]]'
 THEN RAISE EXCEPTION 'Invalid delivery review' USING ERRCODE='22023'; END IF;
 SELECT * INTO claim FROM public.service_proof_consumptions WHERE shop_id=p_shop AND action_id=p_action FOR UPDATE;
 IF claim.proof_id IS NULL THEN RAISE EXCEPTION 'Execution evidence unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM public.delivery_reconciliations WHERE command_id=p_command;
 IF previous.command_id IS NOT NULL THEN
  IF previous.shop_id=p_shop AND previous.action_id=p_action AND previous.actor_id=auth.uid()
    AND previous.revision=p_revision+1 AND previous.outcome=p_outcome AND previous.note=p_note
    AND previous.reviewed_completed_at IS NOT DISTINCT FROM p_completed_at THEN RETURN p_command; END IF;
  RAISE EXCEPTION 'Review command changed' USING ERRCODE='PT409';
 END IF;
 SELECT coalesce(max(revision),0) INTO current_revision FROM public.delivery_reconciliations WHERE shop_id=p_shop AND action_id=p_action;
 IF current_revision<>p_revision OR claim.completed_at IS DISTINCT FROM p_completed_at THEN
  RAISE EXCEPTION 'Execution or review changed; refresh' USING ERRCODE='PT409'; END IF;
 INSERT INTO public.delivery_reconciliations(command_id,shop_id,action_id,revision,actor_id,actor_label,actor_role,outcome,note,reviewed_completed_at)
 VALUES(p_command,p_shop,p_action,current_revision+1,auth.uid(),
   (SELECT display_name FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid()),reviewer,p_outcome,p_note,p_completed_at);
 RETURN p_command;
END $$;

CREATE OR REPLACE FUNCTION public.read_delivery_reconciliation(p_shop uuid,p_action uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE claim public.service_proof_consumptions; items jsonb; current_revision integer; reviewer text;
BEGIN
 reviewer:=public.delivery_review_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE='22023'; END IF;
 SELECT * INTO claim FROM public.service_proof_consumptions WHERE shop_id=p_shop AND action_id=p_action;
 IF claim.proof_id IS NULL THEN RAISE EXCEPTION 'Execution evidence unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO current_revision FROM public.delivery_reconciliations WHERE shop_id=p_shop AND action_id=p_action;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY revision DESC),'[]') INTO items FROM (
  SELECT command_id,revision,actor_id,actor_label,actor_role,outcome,note,created_at,reviewed_completed_at FROM public.delivery_reconciliations
  WHERE shop_id=p_shop AND action_id=p_action ORDER BY revision DESC LIMIT 21 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('revision',current_revision,'completed_at',claim.completed_at,'viewer_role',reviewer,'items',items);
END $$;

-- Bounded queue of consumed sends whose outcome is still held, using the same hold
-- definition as the Whisper inbox. Presentation fields only: no proof identifiers,
-- signed claims or destinations. Reading changes nothing.
CREATE FUNCTION public.list_delivery_holds(p_shop uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE reviewer text; items jsonb;
BEGIN
 reviewer:=public.delivery_review_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.claimed_at DESC,q.action_id),'[]') INTO items FROM (
  SELECT spent.action_id,spent.claimed_at,spent.completed_at,a.action_type::text AS action_type,
   c.id AS customer_id,c.name AS customer_name,left(a.payload->>'body',2000) AS body,
   coalesce(latest.revision,0) AS review_revision,latest.outcome AS latest_outcome
  FROM public.service_proof_consumptions spent
  LEFT JOIN public.pending_actions a ON a.shop_id=spent.shop_id AND a.id=spent.action_id
  LEFT JOIN public.customers c ON c.shop_id=spent.shop_id AND c.id::text=a.payload->>'customer_id'
  LEFT JOIN LATERAL (SELECT r.revision,r.outcome FROM public.delivery_reconciliations r
   WHERE r.shop_id=spent.shop_id AND r.action_id=spent.action_id ORDER BY r.revision DESC LIMIT 1) latest ON true
  WHERE spent.shop_id=p_shop AND (spent.completed_at IS NULL OR a.id IS NULL OR a.result_id IS NULL OR a.status<>'approved')
  ORDER BY spent.claimed_at DESC,spent.action_id LIMIT 21 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('viewer_role',reviewer,'items',items);
END $$;
REVOKE ALL ON FUNCTION public.list_delivery_holds(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_delivery_holds(uuid,integer) TO authenticated;
COMMIT;
