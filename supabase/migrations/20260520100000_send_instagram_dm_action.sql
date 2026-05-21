-- Seventh pending_action_type: send_instagram_dm. Same HITL pattern
-- as send_sms / send_email — agents stage a draft, operator approves
-- in Slack, the engine sends via Meta's Send API on the shop's
-- connected page. Idempotent.

ALTER TYPE public.pending_action_type
  ADD VALUE IF NOT EXISTS 'send_instagram_dm';
