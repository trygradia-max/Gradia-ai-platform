-- In-Gradia voice receptionist builder (TELEPHONY_VOICE_BUILDER_SPEC Phase 2).
--
-- The builder is a guardrailed FORM, never a prompt editor — voice_config
-- holds the owner's form answers (greeting, hours behavior, booking rule,
-- escalation number, curated voice). The system prompt is composed
-- server-side from persona.ts + KB + services + this config.
--
-- Launch gating (spec §2.4): voice_live may only flip on when a number is
-- attached AND the assistant is composed AND a test call happened —
-- enforced in code; these columns are the state it checks.
--
-- vapi_stale marks the assistant for the hourly sync re-PATCH whenever
-- KB/persona/config change (spec §2.2 — voice must never drift from chat).
-- vapi_server_secret_enc is the per-shop webhook auth secret (skill hard
-- rule); legacy assistants without one fall back to the env-global secret.
--
-- voice_minutes_budget: owner-set monthly cap; warn at 80%, refuse the
-- NEXT call at 100% (voice can't be cut mid-call). NULL = no cap beyond
-- the credit ledger's. Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS voice_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_live boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_test_called_at timestamptz,
  ADD COLUMN IF NOT EXISTS vapi_phone_number_id text,
  ADD COLUMN IF NOT EXISTS vapi_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vapi_server_secret_enc text,
  ADD COLUMN IF NOT EXISTS voice_minutes_budget integer;
