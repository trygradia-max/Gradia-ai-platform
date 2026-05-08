-- HITL approval gate: every agent action queues here before it executes.
-- Nothing writes to leads/appointments/etc until a human clicks Approve in Slack.

CREATE TYPE public.pending_action_type AS ENUM ('create_lead');

CREATE TYPE public.pending_action_status AS ENUM (
  'pending',
  'approved',
  'edit_requested',
  'rejected'
);

CREATE TABLE public.pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  action_type public.pending_action_type NOT NULL,
  payload jsonb NOT NULL,
  status public.pending_action_status NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL REFERENCES auth.users (id),
  decided_at timestamptz,
  decided_by_slack text,
  result_id uuid,
  slack_channel text,
  slack_message_ts text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_actions_shop_id_idx ON public.pending_actions (shop_id);
CREATE INDEX pending_actions_status_idx ON public.pending_actions (status);

ALTER TABLE public.pending_actions ENABLE ROW LEVEL SECURITY;

-- Tenant isolation for shop owners. The Slack interactivity route runs
-- under the service role, which bypasses RLS, so callbacks can resolve
-- a pending action without a user session.
CREATE POLICY pending_actions_tenant_isolation ON public.pending_actions
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
