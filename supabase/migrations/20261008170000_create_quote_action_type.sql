-- The voice receptionist stages draft-quote proposals as `create_quote`, and the
-- approval executor and policy adapter already handle that type, but no earlier
-- migration added it to the action enum: a database built from these migrations
-- rejected every quote proposal at staging. Idempotent where a database already
-- has the value. Kept alone because a new enum value must commit before use.
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'create_quote';
