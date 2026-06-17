-- Customer Recovery (P8 / NEXT-3, GRADIA_CUSTOMER_RECOVERY_SPEC). Import the
-- owner's old inbox + contacts, recover past customers (with approval), and
-- win them back under the TCPA/CAN-SPAM gates.

-- Recovered-customer provenance + the fields the win-back gate reads.
--   source              — how the record was first found (import, inbound_sms, …)
--   last_transaction_at — best evidence of the last real job (drives the 18-mo EBR window)
--   do_not_contact      — the owner's manual, immediate, all-channel block
alter table public.customers
  add column if not exists source text,
  add column if not exists last_transaction_at timestamptz,
  add column if not exists do_not_contact boolean not null default false;

-- One import the owner kicked off (an .mbox upload, a contacts CSV/vCard, or a
-- scan of their Gradia-number history). counts is a running jsonb tally
-- (total/kept/dropped/extracted/candidates) so the UI can show progress.
create type public.import_source_type as enum (
  'mbox',
  'contacts_csv',
  'vcard',
  'gradia_history'
);

create type public.import_job_status as enum (
  'pending',
  'parsing',
  'estimating',
  'extracting',
  'ready',
  'failed'
);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  source_type public.import_source_type not null,
  -- Storage path of the raw upload (deleted after extraction per retention).
  file_ref text,
  status public.import_job_status not null default 'pending',
  counts jsonb not null default '{}'::jsonb,
  error text,
  -- Credit estimate shown to the owner before the extract run.
  estimated_credits int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index import_jobs_shop_id_idx on public.import_jobs (shop_id);

-- Staging rows — one per pre-filtered thread/contact. Headers live here for the
-- pre-filter; the raw body stays in the storage bucket (body_ref), NOT in this
-- hot table (spec §1.2). extraction holds the worker's structured output once run.
create table public.import_messages (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references public.import_jobs (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  message_id text,
  from_email text,
  subject text,
  -- Storage path to the raw thread body; nulled out when the body is purged.
  body_ref text,
  has_list_unsubscribe boolean not null default false,
  owner_participated boolean not null default false,
  -- 'kept' threads get extracted; 'dropped' ones carry a drop_reason.
  kept boolean not null default true,
  drop_reason text,
  extraction jsonb,
  created_at timestamptz not null default now()
);

create index import_messages_job_idx on public.import_messages (import_job_id);
create index import_messages_shop_idx on public.import_messages (shop_id);

alter table public.import_jobs enable row level security;
alter table public.import_messages enable row level security;

-- Tenant isolation by shop owner. The import worker runs under the service
-- role (bypasses RLS), same as the cron/Slack paths.
create policy import_jobs_tenant_isolation on public.import_jobs
  for all using (
    shop_id in (select id from public.shops where owner_id = (select auth.uid()))
  )
  with check (
    shop_id in (select id from public.shops where owner_id = (select auth.uid()))
  );

create policy import_messages_tenant_isolation on public.import_messages
  for all using (
    shop_id in (select id from public.shops where owner_id = (select auth.uid()))
  )
  with check (
    shop_id in (select id from public.shops where owner_id = (select auth.uid()))
  );
