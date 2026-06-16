-- Per-shop burst/abuse counters for the rate limiter (src/lib/rate-limit.ts).
-- A soft limiter layered ON TOP of the hard credit gate: the credit allowance
-- (usage_events fail-closed) is the real cost ceiling; this smooths bursts and
-- caps the one UNMETERED cost path (inbound classification) against spam floods.
--
-- Fixed-window counters keyed by (shop_id, bucket, window_start). Stale windows
-- are harmless leftovers — prune out-of-band if the table ever grows.

create table if not exists public.rate_limits (
  shop_id uuid not null references public.shops (id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (shop_id, bucket, window_start)
);

-- Only the service role (which bypasses RLS) reads/writes these internal
-- counters — owners never touch them directly. Enable RLS with NO policies so
-- the anon/authenticated keys can't read or tamper with the limits.
alter table public.rate_limits enable row level security;

comment on table public.rate_limits is
  'Internal per-shop burst/abuse counters (src/lib/rate-limit.ts). Soft limiter atop the hard credit gate; service-role only.';
