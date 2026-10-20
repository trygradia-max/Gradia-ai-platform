BEGIN;
-- Resumable A2P 10DLC registration with clear rejection/retry state.
-- Each provider step's SID is checkpointed as soon as it exists, so a retry
-- resumes after the last completed step instead of rebuilding the chain.
--   failed_step      the step that last failed (NULL when none)
--   retryable        true: a transient/provider-side failure that retrying the
--                    same details can fix; false: carriers or Twilio refused
--                    the submission and the owner must correct details
--   attempts         owner submissions (first submit, resume or resubmit)
--   last_attempt_at  time of the last submission
-- Additive only; no data rewritten. See docs/architecture/CHANNEL_PROVIDERS.md.
ALTER TABLE public.a2p_registrations
  ADD COLUMN failed_step text
    CHECK (failed_step IN ('profile', 'trust_product', 'brand', 'messaging_service', 'campaign', 'attach_number')),
  ADD COLUMN retryable boolean,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN last_attempt_at timestamptz;
COMMIT;
