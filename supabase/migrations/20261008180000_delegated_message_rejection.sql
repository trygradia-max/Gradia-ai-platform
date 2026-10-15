BEGIN;
-- A manager who may approve a queued message may also decline it. Same explicit
-- grant, same review binding. Rejecting sends nothing and consumes no authority;
-- the owner can still restore a rejected action through the existing undo.
CREATE FUNCTION public.reject_delegated_message(p_shop uuid,p_action uuid,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE action public.pending_actions; reviewer text; location uuid; revision integer;
BEGIN
 IF auth.uid() IS NULL OR p_expected IS NULL OR p_expected !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('denied','actor_not_authorized'); END IF;
 -- Same serialization lock as claims, membership changes and policy activation.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 reviewer:=public.message_approval_role(p_shop);
 IF reviewer IS NULL THEN RETURN jsonb_build_object('denied','actor_not_authorized'); END IF;
 SELECT id INTO location FROM public.shop_locations WHERE shop_id=p_shop;
 IF location IS NULL THEN RETURN jsonb_build_object('denied','location_unavailable'); END IF;
 SELECT * INTO action FROM public.pending_actions WHERE id=p_action AND shop_id=p_shop FOR UPDATE;
 IF action.id IS NULL OR action.status::text NOT IN ('pending','edit_requested') THEN RETURN jsonb_build_object('already_decided',true); END IF;
 IF action.action_type::text NOT IN ('send_sms','send_email') THEN RETURN jsonb_build_object('denied','owner_approval_required'); END IF;
 IF action.status::text<>'pending' OR p_expected IS DISTINCT FROM public.control_review_hash(action.payload) THEN
  RETURN jsonb_build_object('denied','review_changed');
 END IF;
 -- A message whose sending authority was already claimed is an uncertain delivery,
 -- not a draft: it is reconciled through delivery review, never quietly dropped.
 IF EXISTS(SELECT 1 FROM public.service_proof_consumptions WHERE shop_id=p_shop AND action_id=p_action) THEN
  RETURN jsonb_build_object('denied','delivery_review_required');
 END IF;
 SELECT a.revision INTO revision FROM public.control_policy_active a WHERE a.shop_id=p_shop;
 INSERT INTO public.control_execution_decisions(shop_id,action_id,actor_id,actor_role,location_id,action_type,policy_revision,staged_revision,payload_hash,context,mode,allowed,reason)
 VALUES(p_shop,p_action,auth.uid(),reviewer,location,action.action_type::text,revision,action.control_staged_revision,encode(sha256(convert_to(jsonb_build_object('shop',p_shop,'location',location,'action',p_action,'type',action.action_type,'payload',action.payload)::text,'UTF8')),'hex'),'hitl','approval',false,'rejected_by_reviewer');
 UPDATE public.pending_actions SET status='rejected',decided_at=now(),decided_by_user=auth.uid() WHERE id=p_action AND shop_id=p_shop;
 RETURN jsonb_build_object('id',action.id,'shop_id',action.shop_id,'action_type',action.action_type);
END $$;
REVOKE ALL ON FUNCTION public.reject_delegated_message(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reject_delegated_message(uuid,uuid,text) TO authenticated;
COMMIT;
