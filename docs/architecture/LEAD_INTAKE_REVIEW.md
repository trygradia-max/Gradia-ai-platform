# Intake review visibility — October 2, 2026

This bounded slice exposes unresolved intake to humans; it does not resolve an
identity or activate a channel. It continues MVP implementation sequence step 3.

The Chief of Staff dashboard shows five recent unresolved workflows inside its
existing needs-you section. Its heading stays unresolved when intake exists or
cannot be loaded. A separate `/intake` view provides pages of 20 workflows and a
workspace selector. Owners reach it from Home; managers reach it through the
existing team workspace link. It uses the same intake records, not a second inbox
or a second settings screen.

`list_lead_intake_review` accepts only a shop selector and bounded page parameters.
Its fixed-search-path database function checks the authenticated user's current
active membership: the actual shop owner, or a manager explicitly granted
`crm.read`. Staff, revoked members, other-shop owners, anonymous callers and a
service client without a user session are denied. Clients still have no direct
read/write grant on intake tables. The function explicitly scopes and joins both
workflow and latest envelope to the selected shop and returns only presentation
fields, never internal evidence references. Reads grant no command authority.

Cards show source, received time in UTC, event revision and safely escaped submitted
fields. Meta cards explicitly say contact details have not been retrieved. Payload
strings are evidence supplied by the sender, not instructions, resolved identities,
or consent. Viewing has no write side effects. The full view does not cache queue
results across requests. Stable received-time/UUID ordering bounds each page;
concurrent arrivals may shift offset pages and can require a refresh.

## Current limits and next dependency

- Read-only: no resolve, dismiss, assignment or acknowledgement action yet.
- Only the latest envelope appears per workflow; a full evidence timeline remains
  future work. Event count/revision is visible so multiple submissions are not
  represented as one original event.
- The existing SMS path can already have created a separate customer/lead; this
  queue never assumes a contact-text match is identity confirmation.
- Website-form intake remains owner-authenticated. Meta contact retrieval and
  shop connection setup are not implemented by this slice.
- A manager needs an explicit CRM-read grant; assignment-only staff cannot see
  unassigned inbound contact details.
- Existing localhost preview runs on another worktree/schema. It was preserved,
  not claimed as a browser-tested preview of this change. Static rendered-component
  tests cover escaping, truthful errors and Meta explanations; live browser and
  accessibility acceptance are still required before release.
- Next: reviewed identity/customer/vehicle linking with stale-review protection,
  durable actor attribution and an atomic workflow transition. No automatic
  identity or consent inference, and no second approval executor.

## Verification

Node 22.23.2: 1,128 unit tests passed (four intentional live skips; 99 files),
278 integration tests passed (zero skips; 28 files). New coverage includes session
RPC boundaries, failed/malformed reads, safe rendered content, tenant separation,
manager grant removal/revocation, staff denial, direct-table mutation denial,
stable pagination and no business/communication writes on viewing.

All 79 migrations applied from zero to the unlinked `gradia-record-fresh` stack;
its ledger exactly matched disk. The existing merge-failure fixture was installed.
All 26 tenant relationship definitions, tenant/photo inconsistent-data refusal
probes and the atomic-record rollback/ACL probe passed. No shared database touched.

Commands use the existing outbound-denying Node runner:
`node scripts/isolated-check.mjs unit`, `integration --fresh`, `lint`, `build`,
then `types`. Fresh initialization:
`supabase --workdir .local-tools/record-fresh db reset --local --no-seed`;
`python3 scripts/verify-agent-record-migration.py --fresh`. Existing tenant/photo
probes were run with their fixed target/config names substituted in memory for the
same disposable stack. No real provider, auth email or model call was made.

Final lint, offline production build and post-build typecheck passed on the final
UI. Whitespace and changed-file credential/runtime-artifact scans passed. Original
founder checkout and CONTEXT.md hash were preserved. This slice is committed locally;
no push, merge, deployment or production migration is included.
