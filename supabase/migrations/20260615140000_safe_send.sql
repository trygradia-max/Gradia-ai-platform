-- B2 (GRADIA_AGENT_MERGE_BRIEF §B2): safe-send guardrails — quiet hours,
-- affirmative consent, and closing the BYO-number A2P bypass. Enforced in code
-- at the SMS send boundary (executeSendSms / send-policy.ts).

-- Per-shop quiet-hours window (TCPA: no marketing texts overnight) + timezone,
-- and a BYO-number A2P attestation flag (Gradia can't see a shop's own carrier
-- registration, so the owner must confirm it before we send through it).
alter table public.shops
  add column if not exists timezone text not null default 'America/New_York',
  add column if not exists quiet_hours_start int not null default 21,
  add column if not exists quiet_hours_end int not null default 8,
  add column if not exists byo_sms_verified boolean not null default false;

-- Affirmative-consent ledger on the customer: explicit opt-in and explicit
-- opt-out timestamps (complements STOP-keyword detection in interactions).
alter table public.customers
  add column if not exists marketing_consent_at timestamptz,
  add column if not exists marketing_consent_source text,
  add column if not exists sms_opted_out_at timestamptz;
