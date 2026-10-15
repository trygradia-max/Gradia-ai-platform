BEGIN;
-- Refuse schema drift instead of silently changing unsupported deletion semantics.
DO $$ DECLARE r record; c record; BEGIN
 FOR r IN SELECT * FROM (VALUES
('action_decisions','action_decisions_pending_action_id_fkey','pending_action_id','pending_actions','c'),
('appointments','appointments_customer_id_fkey','customer_id','customers','n'),
('appointments','appointments_lead_id_fkey','lead_id','leads','n'),
('appointments','appointments_pending_action_id_fkey','pending_action_id','pending_actions','n'),
('appointments','appointments_quote_id_fkey','quote_id','quotes','n'),
('appointments','appointments_vehicle_id_fkey','vehicle_id','vehicles','n'),
('automation_runs','automation_runs_automation_id_fkey','automation_id','automations','c'),
('automation_runs','automation_runs_customer_id_fkey','customer_id','customers','n'),
('automation_runs','automation_runs_lead_id_fkey','lead_id','leads','n'),
('automation_runs','automation_runs_pending_action_id_fkey','pending_action_id','pending_actions','n'),
('bi_messages','bi_messages_conversation_id_fkey','conversation_id','bi_conversations','c'),
('call_records','call_records_customer_id_fkey','customer_id','customers','n'),
('custom_agent_runs','custom_agent_runs_agent_id_fkey','agent_id','custom_agents','c'),
('customer_channel_permissions','customer_channel_permissions_customer_id_fkey','customer_id','customers','c'),
('customers','customers_next_recommended_service_id_fkey','next_recommended_service_id','services','n'),
('import_messages','import_messages_import_job_id_fkey','import_job_id','import_jobs','c'),
('interactions','interactions_customer_id_fkey','customer_id','customers','c'),
('leads','leads_customer_id_fkey','customer_id','customers','n'),
('leads','leads_quote_id_fkey','quote_id','quotes','n'),
('leads','leads_vehicle_id_fkey','vehicle_id','vehicles','n'),
('payments','payments_customer_id_fkey','customer_id','customers','n'),
('quotes','quotes_customer_id_fkey','customer_id','customers','c'),
('quotes','quotes_lead_id_fkey','lead_id','leads','n'),
('quotes','quotes_vehicle_id_fkey','vehicle_id','vehicles','n'),
('vehicles','vehicles_customer_id_fkey','customer_id','customers','c'),
('vehicles','vehicles_import_job_id_fkey','import_job_id','import_jobs','n')
 ) AS manifest(child,name,column_name,parent,delete_action) LOOP
  SELECT * INTO c FROM pg_constraint WHERE conrelid=('public.'||r.child)::regclass AND conname=r.name;
  IF c.oid IS NULL OR c.contype<>'f' OR c.confrelid<>('public.'||r.parent)::regclass OR c.confdeltype::text<>r.delete_action OR c.confupdtype<>'a' OR c.condeferrable OR c.confmatchtype<>'s' OR NOT c.convalidated OR cardinality(c.conkey) NOT IN (1,2) THEN
   RAISE EXCEPTION 'Unsupported relationship definition: %.%; manual review required',r.child,r.name;
  END IF;
  IF (SELECT array_agg(a.attname::text ORDER BY k.ordinal) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) NOT IN (ARRAY[r.column_name],ARRAY['shop_id',r.column_name]) OR
     (SELECT array_agg(a.attname::text ORDER BY k.ordinal) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum) NOT IN (ARRAY['id'],ARRAY['shop_id','id']) THEN
   RAISE EXCEPTION 'Unsupported relationship columns: %.%',r.child,r.name;
  END IF;
 END LOOP;
END $$;
-- Explicit 26-relationship manifest reviewed against the pre-P0 schema.
-- Validated foreign keys refuse mismatches and orphans; no data repairs.
CREATE UNIQUE INDEX IF NOT EXISTS automations_shop_id_id_unique ON public.automations(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS bi_conversations_shop_id_id_unique ON public.bi_conversations(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS custom_agents_shop_id_id_unique ON public.custom_agents(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS customers_shop_id_id_unique ON public.customers(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS import_jobs_shop_id_id_unique ON public.import_jobs(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_shop_id_id_unique ON public.leads(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS pending_actions_shop_id_id_unique ON public.pending_actions(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_shop_id_id_unique ON public.quotes(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS services_shop_id_id_unique ON public.services(shop_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_shop_id_id_unique ON public.vehicles(shop_id,id);
ALTER TABLE public.action_decisions DROP CONSTRAINT action_decisions_pending_action_id_fkey, ADD CONSTRAINT action_decisions_pending_action_id_fkey FOREIGN KEY (shop_id, pending_action_id) REFERENCES public.pending_actions(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.appointments DROP CONSTRAINT appointments_customer_id_fkey, ADD CONSTRAINT appointments_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE public.appointments DROP CONSTRAINT appointments_lead_id_fkey, ADD CONSTRAINT appointments_lead_id_fkey FOREIGN KEY (shop_id, lead_id) REFERENCES public.leads(shop_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE public.appointments DROP CONSTRAINT appointments_pending_action_id_fkey, ADD CONSTRAINT appointments_pending_action_id_fkey FOREIGN KEY (shop_id, pending_action_id) REFERENCES public.pending_actions(shop_id, id) ON DELETE SET NULL (pending_action_id);
ALTER TABLE public.appointments DROP CONSTRAINT appointments_quote_id_fkey, ADD CONSTRAINT appointments_quote_id_fkey FOREIGN KEY (shop_id, quote_id) REFERENCES public.quotes(shop_id, id) ON DELETE SET NULL (quote_id);
ALTER TABLE public.appointments DROP CONSTRAINT appointments_vehicle_id_fkey, ADD CONSTRAINT appointments_vehicle_id_fkey FOREIGN KEY (shop_id, vehicle_id) REFERENCES public.vehicles(shop_id, id) ON DELETE SET NULL (vehicle_id);
ALTER TABLE public.automation_runs DROP CONSTRAINT automation_runs_automation_id_fkey, ADD CONSTRAINT automation_runs_automation_id_fkey FOREIGN KEY (shop_id, automation_id) REFERENCES public.automations(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.automation_runs DROP CONSTRAINT automation_runs_customer_id_fkey, ADD CONSTRAINT automation_runs_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE public.automation_runs DROP CONSTRAINT automation_runs_lead_id_fkey, ADD CONSTRAINT automation_runs_lead_id_fkey FOREIGN KEY (shop_id, lead_id) REFERENCES public.leads(shop_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE public.automation_runs DROP CONSTRAINT automation_runs_pending_action_id_fkey, ADD CONSTRAINT automation_runs_pending_action_id_fkey FOREIGN KEY (shop_id, pending_action_id) REFERENCES public.pending_actions(shop_id, id) ON DELETE SET NULL (pending_action_id);
ALTER TABLE public.bi_messages DROP CONSTRAINT bi_messages_conversation_id_fkey, ADD CONSTRAINT bi_messages_conversation_id_fkey FOREIGN KEY (shop_id, conversation_id) REFERENCES public.bi_conversations(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.call_records DROP CONSTRAINT call_records_customer_id_fkey, ADD CONSTRAINT call_records_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE public.custom_agent_runs DROP CONSTRAINT custom_agent_runs_agent_id_fkey, ADD CONSTRAINT custom_agent_runs_agent_id_fkey FOREIGN KEY (shop_id, agent_id) REFERENCES public.custom_agents(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.customer_channel_permissions DROP CONSTRAINT customer_channel_permissions_customer_id_fkey, ADD CONSTRAINT customer_channel_permissions_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.customers DROP CONSTRAINT customers_next_recommended_service_id_fkey, ADD CONSTRAINT customers_next_recommended_service_id_fkey FOREIGN KEY (shop_id, next_recommended_service_id) REFERENCES public.services(shop_id, id) ON DELETE SET NULL (next_recommended_service_id);
ALTER TABLE public.import_messages DROP CONSTRAINT import_messages_import_job_id_fkey, ADD CONSTRAINT import_messages_import_job_id_fkey FOREIGN KEY (shop_id, import_job_id) REFERENCES public.import_jobs(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.interactions DROP CONSTRAINT interactions_customer_id_fkey, ADD CONSTRAINT interactions_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.leads DROP CONSTRAINT leads_customer_id_fkey, ADD CONSTRAINT leads_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE public.leads DROP CONSTRAINT leads_quote_id_fkey, ADD CONSTRAINT leads_quote_id_fkey FOREIGN KEY (shop_id, quote_id) REFERENCES public.quotes(shop_id, id) ON DELETE SET NULL (quote_id);
ALTER TABLE public.leads DROP CONSTRAINT leads_vehicle_id_fkey, ADD CONSTRAINT leads_vehicle_id_fkey FOREIGN KEY (shop_id, vehicle_id) REFERENCES public.vehicles(shop_id, id) ON DELETE SET NULL (vehicle_id);
ALTER TABLE public.payments DROP CONSTRAINT payments_customer_id_fkey, ADD CONSTRAINT payments_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE public.quotes DROP CONSTRAINT quotes_customer_id_fkey, ADD CONSTRAINT quotes_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.quotes DROP CONSTRAINT quotes_lead_id_fkey, ADD CONSTRAINT quotes_lead_id_fkey FOREIGN KEY (shop_id, lead_id) REFERENCES public.leads(shop_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE public.quotes DROP CONSTRAINT quotes_vehicle_id_fkey, ADD CONSTRAINT quotes_vehicle_id_fkey FOREIGN KEY (shop_id, vehicle_id) REFERENCES public.vehicles(shop_id, id) ON DELETE SET NULL (vehicle_id);
ALTER TABLE public.vehicles DROP CONSTRAINT vehicles_customer_id_fkey, ADD CONSTRAINT vehicles_customer_id_fkey FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE CASCADE;
ALTER TABLE public.vehicles DROP CONSTRAINT vehicles_import_job_id_fkey, ADD CONSTRAINT vehicles_import_job_id_fkey FOREIGN KEY (shop_id, import_job_id) REFERENCES public.import_jobs(shop_id, id) ON DELETE SET NULL (import_job_id);
CREATE FUNCTION public.valid_job_photo_paths(paths text[], shop uuid, appointment uuid, phase text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT phase IN ('before','after') AND shop IS NOT NULL AND appointment IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(paths) path
    WHERE path IS NULL OR split_part(path, '/', 1) <> shop::text
      OR split_part(path, '/', 2) <> appointment::text
      OR array_length(string_to_array(path, '/'), 1) <> 3
      OR split_part(split_part(path, '/', 3), '-', 1) <> phase
      OR split_part(path, '/', 3) !~ ('^(before|after)-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpg|jpeg|png|webp|heic|heif)$')
  );
$$;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_before_photo_scope CHECK (public.valid_job_photo_paths(photos_before, shop_id, id, 'before')),
  ADD CONSTRAINT appointments_after_photo_scope CHECK (public.valid_job_photo_paths(photos_after, shop_id, id, 'after'));

COMMIT;
