-- Private storage bucket for Customer Recovery raw thread/contact bodies
-- (GRADIA_CUSTOMER_RECOVERY_SPEC §1.2 — bodies live in storage, not hot tables;
-- this is the shop's PII, so the bucket is PRIVATE). The import worker reads and
-- purges bodies under the service role, which bypasses storage RLS — so no
-- public/anon policies are added; client code can never read these objects.
insert into storage.buckets (id, name, public)
values ('recovery-imports', 'recovery-imports', false)
on conflict (id) do nothing;
