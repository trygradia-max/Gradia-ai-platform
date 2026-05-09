-- Track dashboard-driven decisions (Approve/Reject from /approvals).
-- decided_by_slack already exists for Slack-driven decisions; this column
-- captures the in-app decider so audit history is complete across surfaces.

ALTER TABLE public.pending_actions
  ADD COLUMN IF NOT EXISTS decided_by_user uuid REFERENCES auth.users (id);
