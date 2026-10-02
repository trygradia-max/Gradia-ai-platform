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


## Owner-reviewed customer linking — October 2, 2026

This follow-on supersedes the read-only limitation above. The existing `/intake`
queue now lets the actual active shop owner search up to 20 same-shop customers,
explicitly select one and confirm the identity. CRM-read managers retain read-only
access. This does not infer consent, create a customer, link a vehicle, qualify a
lead, dismiss an intake or send a communication. New customers still use the
existing CRM. No additional settings screen or execution engine is introduced.

Migration `20261002140000_intake_identity_link.sql` is migration 80. A session-only,
fixed-search-path RPC serializes on the shop and workflow, verifies active ownership,
the reviewed workflow revision and the exact current customer snapshot, then writes
the customer link, revision and actor-attributed decision in one transaction. A
unique command identity makes exact retries idempotent; changed bindings and stale
reviews fail closed. Concurrent distinct decisions have one winner. No direct
client table-write grant is added. Auth-user deletion can null historical actor IDs.

Additional evidence, including late arrivals, reopens identity review. Duplicate
provider events do not reopen it. Event count now counts envelopes, separately from
the workflow revision which also includes human decisions. Customer deletion retains
the workflow with a nullable link; future qualification must require a live owned
customer rather than trusting state alone. The existing atomic customer merge now
moves the workflow link to the surviving customer. Historical decision snapshots
retain the original reviewed identity; consent-preservation logic is unchanged.

### Verification and limitations

Node 22.23.2, final implementation:
- 1,134 unit tests passed in 100 files; four intentional live-provider skips.
- 287 integration tests passed in 29 files; zero skips, synthetic data only.
- Lint, offline production build and post-build typecheck passed.
- All 80 migrations applied from zero and exactly matched the disposable ledger.
- All 26 existing tenant relationship definitions and tenant/photo refusal probes
  passed. The atomic-record rollback/ACL probe passed.
- Nine new database cases cover concurrent retries, competing decisions, unauthorized
  and foreign references, stale/forged snapshots, evidence reopening, immutable
  command bindings, injected rollback, scoped search, and merge success/rollback.
- Six new action tests cover validation, success/retry, failed or malformed replies
  and uncertain outcomes. No automatic retry is attempted.

The first integration run found one obsolete assertion that workflows had no
`customer_id` column. It now asserts that intake leaves the new column null, retaining
the no-automatic-identity guarantee. The final full suite passed after this correction.

Exact commands (using the isolated Node 22 runtime):

```sh
supabase --workdir .local-tools/record-fresh db reset --local --no-seed
node scripts/isolated-check.mjs unit
node scripts/isolated-check.mjs integration --fresh
node scripts/isolated-check.mjs lint
node scripts/isolated-check.mjs build
node scripts/isolated-check.mjs types
python3 scripts/verify-agent-record-migration.py --fresh
git diff --check
```

The test-stack setup installs `tests/sql/merge-failure.sql` and
`tests/sql/intake-link-failure.sql` only in the disposable database; neither fixture
is a production migration. Existing tenant/photo probes were executed with only
the fixed target/config names substituted in memory to `gradia-record-fresh`.
The workflow link uses a same-shop composite foreign key with nullable deletion.

The queue still displays only the latest envelope, not a complete evidence timeline.
An owner must check the existing customer/conversation separately; multiple or
late submissions are not yet fully reviewable here. Linked workflows disappear
from the unresolved queue, with success feedback, but a completed-decision history
screen and qualification continuation are not implemented. Interactive browser and
accessibility acceptance remain required. These limitations prevent treating this
slice as a complete sellable intake workflow.

The prior read-only slice (`81d086f`) is now pushed. This customer-linking slice is
committed locally separately. Shared Supabase, providers, deployment settings and
the protected founder checkout were untouched. This is not pilot activation.


## Evidence and decision history — October 2, 2026

The customer-linking slice at `adcfdf9` is now pushed. This next local slice adds
`/intake/[workflowId]?shop=...`, reached from each existing queue card. It supersedes
the latest-envelope-only visibility limitation: the separate read-only history
shows all submissions and owner identity decisions in bounded pages of 20, ordered
by durable workflow revision. Received and recorded times are shown independently,
so late evidence remains visible in its actual recording order. Queue previews are
explicitly labelled as the latest submission.

Migration `20261002150000_intake_history.sql` adds one fixed-search-path, stable,
session-only read function. It authorizes the actual active owner or an active
manager with `crm.read`, then scopes workflow, transitions and envelopes to the
shop. Anonymous callers, service clients without a user session, staff, foreign
workflows and revoked membership/grants are denied. No table grants or relationships
change. Returned evidence is restricted to customer-facing submission fields;
provider identifiers, internal evidence references and command IDs are omitted.

History also remains readable for completed links. Decisions display the original
customer snapshot and owner user ID, explicitly separated from current customer
state; deleted actors have a truthful fallback. A missing current customer shows a
hold warning. Reading cannot qualify a lead, restore a customer, grant consent,
change a workflow or send a communication.

Continuation pages carry the workflow revision. A changed revision fails with an
explicit refresh-required state rather than mixing versions across pages. Each
request independently checks current permissions. No cross-request cache is used.
Database/read failures remain errors, never an empty-history claim.

### Verification

Node 22.23.2 final checks passed:
- 1,144 units in 101 files; four intentional live-test skips.
- 293 integrations in 30 files; zero skips.
- Lint, offline production build and post-build typecheck.
- Fresh initialization applied all 81 migrations; the ledger exactly matched disk.
- All 26 reviewed tenant relationship definitions, tenant/photo inconsistent-data
  refusal probes and the atomic-record rollback/ACL probe.
- Whitespace and changed-file credential, runtime-artifact and machine-path scans.

Commands: `node scripts/isolated-check.mjs unit`, `integration --fresh`, `lint`,
`build`, then `types`; `supabase --workdir .local-tools/record-fresh db reset --local
--no-seed`; `python3 scripts/verify-agent-record-migration.py --fresh`; `git diff
--check`. Both existing synthetic failure fixtures were installed after reset.
Tenant/photo probes used the same in-memory disposable-target substitutions
previously documented. No shared stack or provider credentials were used.

Ten new unit cases cover validation, response binding, stale/failed reads, escaped
presentation, historical versus current identity, omitted provider IDs and missing
actors/customers. Six new integration cases cover late evidence and pagination,
cross-tenant/role denial, grant removal and revocation, stale pages, completed
historical snapshots after customer edits, and zero mutation across workflow,
evidence, decisions, customers and business/communication tables.

Limitations: interactive browser/a11y acceptance remains pending; this read view
does not prove the human read every page. Identity confirmation remains in the
existing owner queue. A completed history is accessible by its scoped URL, but a
workspace-wide completed-history search/list is not implemented. Vehicle linking,
qualification and channel activation remain separate next dependencies. No second
settings screen, automatic identity resolution or communication executor was added.

GitHub reported no deployment for pushed commit `adcfdf9`; its exact branch Preview
exclusion remains present. The new history slice is local only. The protected
founder checkout remains on its original main commit, with the founder CONTEXT.md
hash unchanged. No production/shared Supabase, merge or deployment operations occurred.
