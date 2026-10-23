BEGIN;
-- Operator-visible terminal delivery conflicts, on the existing delivery
-- review surface (20261006120000, 20261008120000).
--
-- The status callback (#99) keeps the first terminal outcome in
-- interactions.metadata.twilio_status and a contradicting one (delivered vs
-- undelivered/failed/canceled, either order) in metadata.twilio_status_conflict.
-- Nothing showed that to anyone. This adds:
--   - list_delivery_conflicts / read_delivery_conflict: bounded, authorized
--     reads. A contradicted message reads as 'conflicting', never 'delivered';
--   - record_delivery_conflict_resolution: a human assessment, audited with
--     actor, role, scope (shop, message, the conflict reviewed) and reason.
-- Authority is the existing delivery_review_role: the shop's owner, or an
-- active manager explicitly granted crm.read + delivery.reconcile. Revoked or
-- deactivated members are refused on every call.
-- A resolution is evidence only. It never edits the message's delivery
-- metadata, resends, releases sending authority or changes any hold. If a
-- newer conflicting callback arrives after a resolution, the message reads as
-- unresolved again.
-- Additive: one new table, three functions. Existing rows are unchanged.

CREATE TABLE public.delivery_conflict_resolutions (
 command_id uuid PRIMARY KEY,
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 interaction_id uuid NOT NULL REFERENCES public.interactions(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK (revision > 0),
 actor_id uuid NOT NULL,
 actor_label text NOT NULL,
 actor_role text NOT NULL CHECK (actor_role IN ('owner','manager')),
 outcome text NOT NULL CHECK (outcome IN ('delivered','not_delivered','unknown')),
 note text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 2000 AND note=btrim(note)
   AND regexp_replace(note,E'[\n\r\t]','','g') !~ '[[:cntrl:]]'),
 -- The exact evidence the reviewer saw, copied (the message's metadata is never edited).
 reviewed_status text NOT NULL,
 reviewed_error_code text,
 reviewed_conflict_status text NOT NULL,
 reviewed_conflict_error_code text,
 reviewed_conflict_received_at text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(shop_id,interaction_id,revision)
);
ALTER TABLE public.delivery_conflict_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_conflict_resolutions FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.delivery_conflict_resolutions_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Conflict resolutions are append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER delivery_conflict_resolutions_no_update BEFORE UPDATE ON public.delivery_conflict_resolutions
 FOR EACH ROW EXECUTE FUNCTION public.delivery_conflict_resolutions_append_only();

-- Private. One conflicted message's presentation, or NULL when the message
-- isn't an outbound SMS with a recorded conflict in this shop.
CREATE FUNCTION public.delivery_conflict_item(p_shop uuid,p_interaction uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE i public.interactions; c jsonb; latest public.delivery_conflict_resolutions; cust text;
BEGIN
 SELECT * INTO i FROM public.interactions WHERE id=p_interaction AND shop_id=p_shop AND channel='sms' AND role='gradia';
 IF i.id IS NULL OR jsonb_typeof(i.metadata->'twilio_status_conflict') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 c:=i.metadata->'twilio_status_conflict';
 SELECT * INTO latest FROM public.delivery_conflict_resolutions WHERE shop_id=p_shop AND interaction_id=i.id ORDER BY revision DESC LIMIT 1;
 SELECT name INTO cust FROM public.customers WHERE shop_id=p_shop AND id=i.customer_id;
 RETURN jsonb_build_object(
  'interaction_id',i.id,'occurred_at',i.occurred_at,'customer_id',i.customer_id,'customer_name',cust,
  'body',left(i.content,2000),
  'action_id',CASE WHEN (i.metadata->>'pending_action_id') ~ '^[0-9a-f-]{36}$' THEN i.metadata->>'pending_action_id' END,
  -- Never an unqualified success: this message has contradicting outcomes.
  'delivery_state','conflicting',
  'recorded_status',i.metadata->>'twilio_status','recorded_error_code',i.metadata->>'twilio_error_code',
  'conflict_status',c->>'status','conflict_error_code',c->>'error_code','conflict_received_at',c->>'received_at',
  'review_revision',coalesce(latest.revision,0),'latest_outcome',latest.outcome,
  -- Resolved only by a review of THIS conflict; a newer one reopens it.
  'resolution_state',CASE WHEN latest.command_id IS NOT NULL
    AND latest.reviewed_conflict_received_at IS NOT DISTINCT FROM c->>'received_at'
    AND latest.reviewed_conflict_status IS NOT DISTINCT FROM c->>'status' THEN 'resolved' ELSE 'unresolved' END);
END $$;

-- Bounded queue of conflicted outbound texts, newest first, unresolved first.
CREATE FUNCTION public.list_delivery_conflicts(p_shop uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE reviewer text; items jsonb;
BEGIN
 reviewer:=public.delivery_review_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(q.item ORDER BY q.unresolved DESC,q.occurred_at DESC,q.id),'[]') INTO items FROM (
  SELECT x.id,x.occurred_at,x.item,(x.item->>'resolution_state')='unresolved' AS unresolved FROM (
   SELECT i.id,i.occurred_at,public.delivery_conflict_item(p_shop,i.id) AS item FROM public.interactions i
   WHERE i.shop_id=p_shop AND i.channel='sms' AND i.role='gradia' AND i.metadata ? 'twilio_status_conflict'
  ) x WHERE x.item IS NOT NULL
  ORDER BY unresolved DESC,x.occurred_at DESC,x.id LIMIT 21 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('viewer_role',reviewer,'items',items);
END $$;

-- One conflicted message with its resolution history (21 per page).
CREATE FUNCTION public.read_delivery_conflict(p_shop uuid,p_interaction uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE reviewer text; item jsonb; history jsonb;
BEGIN
 reviewer:=public.delivery_review_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE='22023'; END IF;
 item:=public.delivery_conflict_item(p_shop,p_interaction);
 IF item IS NULL THEN RAISE EXCEPTION 'Delivery conflict unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY revision DESC),'[]') INTO history FROM (
  SELECT command_id,revision,actor_id,actor_label,actor_role,outcome,note,created_at,
   reviewed_status,reviewed_error_code,reviewed_conflict_status,reviewed_conflict_error_code,reviewed_conflict_received_at
  FROM public.delivery_conflict_resolutions WHERE shop_id=p_shop AND interaction_id=p_interaction
  ORDER BY revision DESC LIMIT 21 OFFSET p_offset
 ) q;
 RETURN item||jsonb_build_object('viewer_role',reviewer,'history',history);
END $$;

-- The reviewer records what they established. Idempotent per command id;
-- refused if the review history or the conflict changed since it was read.
CREATE FUNCTION public.record_delivery_conflict_resolution(p_shop uuid,p_interaction uuid,p_command uuid,p_revision integer,
 p_conflict_received_at text,p_outcome text,p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE reviewer text; i public.interactions; c jsonb; previous public.delivery_conflict_resolutions; current_revision integer;
BEGIN
 -- Lock the shop before checking live authority, so a concurrent revocation
 -- or grant removal serializes with this write.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 reviewer:=public.delivery_review_role(p_shop);
 IF auth.uid() IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_interaction IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>=2147483647
 OR p_outcome IS NULL OR p_outcome NOT IN ('delivered','not_delivered','unknown') OR p_note IS NULL
 OR char_length(p_note) NOT BETWEEN 10 AND 2000 OR p_note IS DISTINCT FROM btrim(p_note)
 OR regexp_replace(p_note,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' OR p_conflict_received_at IS NULL
 THEN RAISE EXCEPTION 'Invalid delivery review' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.interactions WHERE id=p_interaction AND shop_id=p_shop AND channel='sms' AND role='gradia' FOR UPDATE;
 IF i.id IS NULL OR jsonb_typeof(i.metadata->'twilio_status_conflict') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Delivery conflict unavailable' USING ERRCODE='42501'; END IF;
 c:=i.metadata->'twilio_status_conflict';
 SELECT * INTO previous FROM public.delivery_conflict_resolutions WHERE command_id=p_command;
 IF previous.command_id IS NOT NULL THEN
  IF previous.shop_id=p_shop AND previous.interaction_id=p_interaction AND previous.actor_id=auth.uid()
   AND previous.revision=p_revision+1 AND previous.outcome=p_outcome AND previous.note=p_note
   AND previous.reviewed_conflict_received_at=p_conflict_received_at THEN RETURN p_command; END IF;
  RAISE EXCEPTION 'Review command changed' USING ERRCODE='PT409';
 END IF;
 SELECT coalesce(max(revision),0) INTO current_revision FROM public.delivery_conflict_resolutions WHERE shop_id=p_shop AND interaction_id=p_interaction;
 IF current_revision<>p_revision OR c->>'received_at' IS DISTINCT FROM p_conflict_received_at THEN
  RAISE EXCEPTION 'Delivery evidence or review changed; refresh' USING ERRCODE='PT409'; END IF;
 INSERT INTO public.delivery_conflict_resolutions(command_id,shop_id,interaction_id,revision,actor_id,actor_label,actor_role,outcome,note,
  reviewed_status,reviewed_error_code,reviewed_conflict_status,reviewed_conflict_error_code,reviewed_conflict_received_at)
 VALUES(p_command,p_shop,p_interaction,current_revision+1,auth.uid(),
  (SELECT display_name FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid()),reviewer,p_outcome,p_note,
  coalesce(i.metadata->>'twilio_status','unknown'),i.metadata->>'twilio_error_code',c->>'status',c->>'error_code',p_conflict_received_at);
 RETURN p_command;
END $$;

REVOKE ALL ON FUNCTION public.delivery_conflict_resolutions_append_only(),public.delivery_conflict_item(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.list_delivery_conflicts(uuid,integer),public.read_delivery_conflict(uuid,uuid,integer),
 public.record_delivery_conflict_resolution(uuid,uuid,uuid,integer,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_delivery_conflicts(uuid,integer),public.read_delivery_conflict(uuid,uuid,integer),
 public.record_delivery_conflict_resolution(uuid,uuid,uuid,integer,text,text,text) TO authenticated;

-- Keep a private-review database frozen when adding this audit table.
DO $$ BEGIN
 IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
  CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_conflict_resolutions
   FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes();
  ALTER TABLE public.delivery_conflict_resolutions ENABLE ALWAYS TRIGGER gradia_release_freeze;
 END IF;
END $$;
COMMIT;
