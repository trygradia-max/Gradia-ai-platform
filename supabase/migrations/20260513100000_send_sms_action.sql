-- Fourth pending_action_type: send_sms. AI-initiated outbound SMS
-- propositions land as pending_actions; on approval the engine calls
-- Twilio and records the outbound message as an interaction. Operator-
-- direct sends (the "Quick reply" UI) bypass this enum entirely since
-- the operator is the human and HITL is satisfied.
-- Idempotent.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'send_sms';
