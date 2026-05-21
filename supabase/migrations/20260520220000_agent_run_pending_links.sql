-- Capture which pending_actions an agent run produced, so the run-
-- history UI can deep-link from "3 proposed sms" to the actual cards.
-- Optional array — agents that don't stage approvals (log_note,
-- flag_for_review) just leave it empty.
-- Idempotent.

ALTER TABLE public.custom_agent_runs
  ADD COLUMN IF NOT EXISTS pending_action_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
