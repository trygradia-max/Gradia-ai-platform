BEGIN;
-- Human evidence only: never updates pending actions or reusable send authority.
CREATE TABLE public.delivery_reconciliations (
 command_id uuid PRIMARY KEY,
 shop_id uuid NOT NULL,
 action_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision > 0),
 actor_id uuid NOT NULL,
 actor_label text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('delivered','not_delivered','unknown')),
 note text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 2000 AND note=btrim(note)
   AND regexp_replace(note,E'[\n\r\t]','','g') !~ '[[:cntrl:]]'),
 reviewed_completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(shop_id,action_id,revision),
 FOREIGN KEY(shop_id,action_id) REFERENCES public.service_proof_consumptions(shop_id,action_id) ON DELETE CASCADE
);
ALTER TABLE public.delivery_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_reconciliations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.record_delivery_reconciliation(p_shop uuid,p_action uuid,p_command uuid,p_revision integer,p_completed_at timestamptz,p_outcome text,p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE claim public.service_proof_consumptions; previous public.delivery_reconciliations; current_revision integer;
BEGIN
 -- Session-only owner operation. Lock the shop before checking live authority.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(
   SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active
 ) THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
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
 INSERT INTO public.delivery_reconciliations(command_id,shop_id,action_id,revision,actor_id,actor_label,outcome,note,reviewed_completed_at)
 VALUES(p_command,p_shop,p_action,current_revision+1,auth.uid(),
   (SELECT display_name FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid()),p_outcome,p_note,p_completed_at);
 RETURN p_command;
END $$;

CREATE FUNCTION public.read_delivery_reconciliation(p_shop uuid,p_action uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE claim public.service_proof_consumptions; items jsonb; current_revision integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(
  SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active
 ) THEN RAISE EXCEPTION 'Delivery review unavailable' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE='22023'; END IF;
 SELECT * INTO claim FROM public.service_proof_consumptions WHERE shop_id=p_shop AND action_id=p_action;
 IF claim.proof_id IS NULL THEN RAISE EXCEPTION 'Execution evidence unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO current_revision FROM public.delivery_reconciliations WHERE shop_id=p_shop AND action_id=p_action;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY revision DESC),'[]') INTO items FROM (
  SELECT command_id,revision,actor_id,actor_label,outcome,note,created_at,reviewed_completed_at FROM public.delivery_reconciliations
  WHERE shop_id=p_shop AND action_id=p_action ORDER BY revision DESC LIMIT 21 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('revision',current_revision,'completed_at',claim.completed_at,'items',items);
END $$;
REVOKE ALL ON FUNCTION public.record_delivery_reconciliation(uuid,uuid,uuid,integer,timestamptz,text,text),public.read_delivery_reconciliation(uuid,uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.record_delivery_reconciliation(uuid,uuid,uuid,integer,timestamptz,text,text),public.read_delivery_reconciliation(uuid,uuid,integer) TO authenticated;
COMMIT;
