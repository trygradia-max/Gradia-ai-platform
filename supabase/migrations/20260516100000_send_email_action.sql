-- Sixth pending_action_type: send_email. Same HITL pattern as
-- send_sms — agents stage a draft, operator approves in Slack, the
-- engine sends from the shop's connected Aurinko mailbox. Operator-
-- direct compose bypasses this enum (skipped for the first chunk
-- of outbound email work).
-- Idempotent.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'send_email';
