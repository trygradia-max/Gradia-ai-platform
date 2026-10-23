# AI work log

Every Claude Code, Cursor, and Codex session that changes Gradia appends one
entry here before it finishes. Read this file before starting so you do not
redo finished work or overwrite another tool’s uncommitted edit.

## Tag

Use this exact shape:

`[AI: cursor | claude-code | codex] [DATE: YYYY-MM-DD] [AREA: platform | marketing | docs | archive] [STATUS: done | in-progress | blocked]`

Then one short paragraph: what changed, the branch or PR, and what was
deliberately not done.

Do not tag a merge, deploy, or production change unless that session actually
merged, deployed, or changed production.

## Entries

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Reconciled MVP documentation onto `codex/mvp-documentation-reconciliation`
and opened draft PR #49. Recorded the September 11 documents as authority,
PR #48 as merged draft-only Control Center code, and left founder `CONTEXT.md`
at local `20e153a` untouched. Did not implement features, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Recorded the founder trial decision: no free trial. A future exception, if
ever approved, is manual tools only and excludes AI. Recorded payments/POS as
a future intention, not current MVP. Described fleet accounts and full work
orders without adding them to the pilot. Added this log and the README rule.
Moved loose parent-folder clutter into `old-gradia-info/`. Did not move
`platform/`, `marketing/`, worktrees, or scripts.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Recorded the founder confirmation that full work orders are a future Gradia
product system, alongside payments and POS. Fleet accounts stay described
only. No build, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Recorded three future products, not in the MVP: win-back campaigns, Google
review request texts, and on-the-go owner access by texting a Gradia number
or an in-app Muse-style conversation. Same Agent. No build, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Added `docs/CHEAT_SHEET.md` and linked it from the README and `CLAUDE.md`.
No product code, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Corrected the diary `CONTEXT.md` on this branch so it no longer outranks the
five September 11 documents. Fixed the false "no data export" and "email is
read-only" lines, and stopped the build list from sending the next session to
billing. Founder checkout untouched. Parent `CLAUDE.md`, pricing, and
`WHAT_GRADIA_DOES.md` got the same warning. No application code.

[AI: cursor] [DATE: 2026-09-27] [AREA: platform] [STATUS: done]
Finished the local Control Center execution slice on
`codex/mvp-policy-execution` at `f2fccee`. Saving a draft still does nothing
until the owner activates that revision. The approval claim rechecks the
current policy, and catalog automations are marked automatic instead of
looking like an owner approval. Verified on the disposable test stack only:
1,024 unit tests passed with the four existing live skips, 210 integration
tests passed with zero skips, and the permission/rollback probe passed.
Preview deploy for this branch is disabled. Not pushed, merged, or deployed.
Manager approval stays owner-only. Direct tools, voice, alerts, and crons are
not covered by this claim.

[AI: codex] [DATE: 2026-09-29] [AREA: platform] [STATUS: done]
Resumed policy execution commit `f2fccee` without recreating completed work.
Finished disposable browser activation verification and reran 1,024 unit tests
(four intentional live skips), 210 integration tests (zero skips), lint, offline
Node 22 build and post-build typecheck. Corrected the historical 70→71 probe to
remove later dependent tables only inside its rolled-back transaction; all 72
ledger, permission, relationship and refusal probes pass. Existing editor and
executor reused; no second settings screen. The bounded execution slice is ready
for local review; complete direct-tool/transport policy coverage and delegated
manager approvals remain outstanding. No push, merge, deployment, production or
provider activity. Founder checkout and CONTEXT.md preserved. See the September 29
entry in `docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md` for limitations.

[AI: codex] [DATE: 2026-09-29] [AREA: platform] [STATUS: done]
Added the bounded Agent capture adapter: owner-Agent notes/leads and MCP lead
proposals now use a durable, current-policy staging RPC and the existing approval
executor. Added migration 73, command retry binding, token revocation checks and
Shadow Mode enforcement. Verified 1,037 unit tests (four existing live skips),
220 integration tests (zero skips), fresh 73-migration initialization, all existing
migration probes, lint, offline build and post-build typecheck. Live model routing
evaluation remains unrun; capture prompt wording and its eval expectations now say
queued rather than saved. Direct customer edits/materialization and MCP memory
writes remain the next adapter work. This does not complete universal Control Center
coverage. No push, merge, deploy, production/provider action or founder-file change.

[AI: cursor] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Finished the local record-command slice on `codex/mvp-policy-execution`.
Owner-agent customer edits, MCP identity resolution, and MCP reported history
now queue for review and commit only inside the existing approval claim.
Lead-only matches queue identity resolution instead of creating a customer or
disappearing. Customer and vehicle writes advance `updated_at`, so a stale
snapshot rolls back. Verified on the already-initialized disposable stack:
16 record integration tests, 30 adjacent integration tests, and 16 focused
unit tests passed; typecheck and touched-file lint passed. No from-zero reset,
full suite, build, browser pass, push, merge, or deploy. MCP read scoping,
voice, alerts, crons, and delegated manager approval remain uncovered.

[AI: codex] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Completed verification and hardened the existing local record-command slice.
Customer/vehicle edits, identity resolution and reported history use existing
policy-controlled approvals with atomic domain write, audit and claim. Added
canonical lead identity comparison, field-bound vehicle snapshots and customer-bound
history references. Final Node 22 results: 1,048 unit tests passed (four intentional
live skips), 239 integration tests passed (zero skips), lint, offline build and
post-build typecheck passed. All 75 migrations initialized from zero in a separate
unlinked disposable stack; all migration probes and 26 relationship checks passed.
A fictional customer edit was approved in the local browser and verified in the
database with exactly one decision audit. Local preview preserved. Live model evals
and broader policy coverage remain outstanding as documented in
`docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md`. Nothing pushed, merged,
deployed or sent to production/providers; protected founder checkout unchanged.

[AI: cursor] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Added the first half of normalized lead intake on `codex/mvp-lead-intake`,
based on `a02fc97`. `record_lead_intake` writes one envelope and one workflow
transition in the same transaction, deduped on provider plus provider event id.
The shop id is an explicit argument. Contact text is stored only. The workflow
stays in `identity_review` with handoff pending. A duplicate, an out-of-order
explicit thread, and a replay after the row is saved keep a single record and
do not create a customer, lead, consent row, or approval. Focused result on
the already-initialized disposable stack: 3 unit tests, 4 integration tests,
touched-file lint, and typecheck passed. Migration `20261001130000` was applied
in place (ledger 76); no from-zero reset, full suite, or build. Did not wire
live SMS, the website form, Meta, or a Chief of Staff card, and did not change
owner-agent, MCP, approvals, or agent capture. Nothing pushed, merged, or deployed.

[AI: cursor] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Wired the existing Twilio inbound SMS webhook on `codex/mvp-lead-intake` through
`record_lead_intake`. After signature verification and the provider-event claim,
each MessageSid writes one intake envelope and one workflow transition. A
duplicate delivery and a retry after the row is saved keep that single record;
the first payload wins, and the sender phone is not a thread key. The intake
write does not create a customer, lead, consent row, or approval. The existing
SMS path still resolves or creates a customer, applies STOP/START consent, and
stages `create_lead` for review when the classifier marks a lead. Verified on
the disposable stack: 5 lead-intake unit tests, 77 webhook unit tests, 5
lead-intake integration tests, and 14 Twilio inbound replay integration tests
passed; touched-file lint passed. No website-form handler exists in this tree,
so it was not built. Did not build Meta lead ads or a Chief of Staff card.
Nothing pushed, merged, or deployed.

[AI: cursor] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Added website-form intake on `codex/mvp-lead-intake`. `POST /api/intake/website-form`
calls `record_lead_intake` once per caller-supplied submission id, with provider
`website_form`. This app has no website-form token or public form key — a quote
`public_token` identifies one quote, not a lead form — so the shop is the
signed-in owner's active shop. A missing shop, a body shop id that does not
match that session, or a submission id already stored for another shop does not
write. An unsigned body cannot name the tenant, and no public marketing site
was added. Submitted fields are stored as text. Phone and email are not a
thread key unless the caller sends one. The write does not create a customer,
lead, consent row, or approval. Disposable-stack result: 5 website-form
integration tests, 5 existing lead-intake integration tests, 14 Twilio inbound
replay integration tests, 9 lead-intake unit tests, 6 tenant-scoping unit tests,
and 77 webhook unit tests passed; touched-file lint and typecheck passed. Did
not build A2P, Twilio Trust Hub, Meta lead ads, or a Chief of Staff card, and
did not push, merge, or deploy.

[AI: cursor] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Added Meta Lead Ads intake on `codex/mvp-lead-intake`. `GET` and `POST /api/intake/meta-lead-ads`
check `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `META_APP_SECRET`) before any
parse or write, and fail closed when that secret is unset. The shop is a row in
`meta_lead_page_bindings` (`shop_id` plus a unique `page_id`). An unknown page, a page bound
to two shops, or a body shop id that disagrees with the binding does not write. Provider
`meta_lead_ads`, event id the Meta `leadgen_id`; the first payload wins. The envelope stores
`page_id`, `form_id`, `leadgen_id`, and `created_time` only, with no thread key. The write
does not create a customer, lead, consent row, or approval. The hub challenge is echoed only
when `META_WEBHOOK_VERIFY_TOKEN` matches, and is refused when that token is unset. Disposable
stack: 5 Meta integration tests, 5 existing lead-intake integration tests, 5 website-form
integration tests, 14 Twilio inbound replay tests, and 21 focused unit tests passed;
touched-file lint and typecheck passed. Migration `20261002075347` was applied in place on
`gradia-isolated-tests` (ledger 77). Did not call the Meta Graph API
(`meta_graph_lead_field_retrieval` remains), did not map in-body `field_data`, and did not
build an OAuth connect screen, a Settings tile, a Chief of Staff card, or A2P. Nothing
pushed, merged, or deployed.

[AI: codex] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Added the next bounded Control Center adapter: current-authority admission for
all ten MCP data-reading tools/resources. Rechecks token/shop/current owner and
membership, then the activated policy; Off and unavailable authority deny before
business data or embedding access. Reuses existing policies/settings, no schema or
UI added. 1,093 unit tests passed (four intentional live skips), 243 integration
tests passed (zero skips), lint, offline Node 22 build and post-build typecheck
passed. PR #50's prior a02fc97 checks were both green before starting. New work
remains local. No production/provider activity or founder-file changes. Per-token
capability grants, read audit, in-flight revocation semantics and remaining MCP
proposal/transport policy coverage are explicitly not complete; see the October 2
section of docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md.

[AI: codex] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Added explicit per-token MCP read/proposal grants in the existing Settings card and
migration 76 (existing tokens default to no grants). Routed remaining booking,
SMS and email proposals through durable policy-controlled staging with customer/
destination validation, stable command IDs and token checks at staging and approval.
Removed provider-reaching booking preflight; approval retains authoritative checks.
Final Node 22 verification: 1,102 unit tests (four live skips), 254 integration tests
(zero skips), lint, offline build and post-build typecheck passed. Fresh exact
76-migration ledger, all 26 tenant relationships and refusal/rollback probes passed.
Used the separate disposable fresh stack after the usual stack's unrelated extra
migration caused migration-up refusal; preserved that stack and the local demo.
Existing fault fixture was installed before the passing full integration rerun.
Release requires explicit replacement of legacy unscoped tokens and live tool evals;
new grant-picker browser testing remains outstanding. See the implementation report.
No push, merge, deployment, production/provider activity or founder-file changes.

[AI: codex] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Prepared the additional intake work for push. Preserved commits bdbdb5a, b998248,
8ca34ab and 6ce508a, merged the current policy/capability branch 2e634cf locally
without rewriting history, and retained both work-log histories. Merge commit
45d2609 adds the exact Vercel exclusion for codex/mvp-lead-intake while preserving
all other deployment settings. This is a feature-branch reconciliation, not a merge
into main or a production deployment.

Combined Node 22.23.2 verification passed: 1,118 unit tests (four intentional live
skips; 97 files), 272 database integration tests (zero skips; 27 files), lint,
offline production build and post-build typecheck. All 78 migrations initialized
from zero on the separate unlinked gradia-record-fresh stack with the existing
merge-failure fixture. Exact ledger, atomic-record rollback/ACL probe, all 26 tenant
relationship definitions and tenant/photo inconsistent-data refusal probes passed.
Commands: node scripts/isolated-check.mjs unit; integration --fresh; lint; build;
types; python3 scripts/verify-agent-record-migration.py --fresh. Tenant/photo probes
used their existing code with only the fixed disposable target/config names
substituted in memory. Credential-pattern scans covered every previously unpushed
commit; changed files passed runtime-artifact, machine-path and whitespace checks.
No dependencies installed, shared database modified or real provider contacted.

This is intake foundation, not pilot activation. Website-form intake requires a
signed-in shop owner; it is not yet a public lead form. Meta POST verifies HMAC;
GET validates only the subscription verify token. Meta stores notification IDs,
not contact fields; Graph retrieval, connect/binding UI and Chief of Staff intake
review remain unfinished. Intake workflows remain in identity_review; the existing
SMS handling still performs its separate customer/consent flow. Missing routing,
provider acceptance, live tool evaluation, existing-token replacement and production
release safeguards remain gates. Founder checkout and CONTEXT.md hash are unchanged.

[AI: codex] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Added read-only unresolved intake visibility to Chief of Staff and a paginated
/intake workspace view, linked from the team page. Owners and explicitly CRM-read
managers can inspect submitted details; a session-only fixed-search-path RPC checks
live membership and shop ownership. Staff, revoked managers and cross-shop reads
are denied. No identity/consent inference, acknowledgement or business writes.
The dashboard does not claim all-clear when intake exists or cannot load. Meta
cards disclose missing contact retrieval. Final Node 22 checks: 1,128 unit tests
passed (four intentional live skips), 278 integration tests passed (zero skips),
lint, offline build and post-build types passed. Fresh 79-migration ledger, all 26
tenant relationship definitions and refusal/rollback probes passed. Static render
regressions passed; interactive browser/a11y acceptance remains outstanding.
Next is reviewed identity linking and atomic workflow advancement, not provider
activation. See docs/architecture/LEAD_INTAKE_REVIEW.md. Local commit only; no push,
merge, deployment, production/provider activity or protected founder-file change.


[AI: codex] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Pushed the existing intake-review slice at 81d086f to codex/mvp-lead-intake. Built
owner-confirmed linking to an existing same-shop customer in the existing queue.
Database-enforced active-owner authorization, exact customer snapshot and workflow
revision checks, durable command dedupe and atomic audit/link updates prevent stale,
foreign or duplicate decisions. New evidence reopens review; duplicate intake does
not. Existing atomic customer merges preserve workflow links and immutable decision
history, with rollback coverage. No consent inference, delivery or qualification.
Migration 80 applied from zero to the unlinked disposable stack. Final Node 22:
1,134 units passed (four live skips), 287 integrations passed (zero skips), lint,
offline build and post-build types passed; exact 80-migration ledger, all 26 prior
tenant constraints and refusal/rollback probes passed. Full evidence history,
vehicle linking, qualification and interactive browser acceptance remain outstanding.
See docs/architecture/LEAD_INTAKE_REVIEW.md. New slice is local only; no merge,
deployment, shared database/provider activity or protected founder-file changes.


[AI: codex] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Pushed verified customer-linking commit adcfdf9 on codex/mvp-lead-intake. Built the
next bounded slice: read-only, paginated intake evidence and decision history,
including late submissions and completed identity decisions. Session-only SQL
checks live owner/CRM-read manager authority and same-shop relationships. Revision-
anchored continuation rejects stale history; historical customer snapshots remain
separate from current records. Provider/internal evidence IDs are withheld. Reads
have no domain, consent or delivery effects. Migration 81 adds only the read RPC.
Final Node 22: 1,144 unit passes (four intentional live skips), 293 integration
passes (zero skips), lint, offline build and post-build types passed. Fresh exact
81-migration ledger, all 26 tenant relationships and refusal/rollback probes passed.
Interactive browser/a11y acceptance and completed-history search remain outstanding.
Vehicle linking and qualification remain next. See docs/architecture/LEAD_INTAKE_REVIEW.md.
New history slice is committed locally, not pushed; no merge, deployment, production,
provider activity or protected founder-file changes.


[AI: codex] [DATE: 2026-10-04] [AREA: platform] [STATUS: done]
Completed reviewed vehicle linking in the existing intake history. Owners explicitly
select an existing vehicle belonging to the confirmed same-shop customer. SQL checks
live authority, workflow revision, customer timestamp and exact vehicle snapshot;
link/revision/audit commit atomically with durable command dedupe. Customer changes
and new evidence invalidate the current link; edits require review; deletion retains
nullable workflow references and immutable history. A composite FK rejects foreign
customer references and direct reassignment of a linked vehicle. Existing customer
merges clear vehicle confirmation, preserving rollback and historical decisions.
Migration 82 applied from zero to the dedicated disposable stack. Node 22: 1,153
unit passes (four live skips), 305 integration passes (zero skips), lint, offline
build and post-build types passed. Exact ledger, both intake relationships, 26 prior
tenant constraints, RPC grants and refusal/rollback probes passed. No qualification,
consent change, communication or second settings screen. Browser/a11y acceptance,
completed-workflow discovery and reassignment recovery remain limited. See
LEAD_INTAKE_REVIEW.md for commands and restrictions. Local commit only; no push,
merge, deployment, shared Supabase/provider activity or protected founder changes.

[AI: codex] [DATE: 2026-10-05] [AREA: platform] [STATUS: done]
Built the first Whisper operational-inbox slice in the existing /conversations
route: shop/customer/channel history, personal unread acknowledgement, owner and
explicitly authorized manager handoff, in-app notifications, and owner SMS/email
drafts staged through existing Approvals. No new transport, message store, settings
screen or Agent engine. Pending/uncertain execution remains visible; handoff flags
do not pause queued delivery. Active membership, assigned staff visibility, current
recipient binding, stale revision checks, durable command dedupe and atomic audit
are database enforced. Direct RPC payloads reject caller classifications/proofs.
Customer merges preserve metadata conservatively, clear assignments and reset read
state while retaining restrictive consent/provenance and original audit bindings.

Migration 83 applied from zero to unlinked gradia-record-fresh. Final Node 22:
1,162 unit passes in 104 files (four existing intentional live skips); 322 integration
passes in 32 files (zero skips); lint, offline build and post-build typecheck passed.
The 17 new integration cases and nine units cover authority, direct RPC abuse,
concurrent commands, stale recipients, notifications, SMS/email staging, unknown
execution, merge collisions/failure and transactional rollback. Exact 83-version
ledger, four new composite relationships, direct-table denial and session-only
RPC grants passed catalog checks; original 26 tenant relationships, intake
relationships and tenant/photo refusal plus atomic-record rollback probes passed.
Whitespace and changed-file credential/runtime/machine-path scans passed.

Interactive browser checks used fictional local owner/manager sessions under an
outbound-denied preview: owner handoff persisted, one draft entered Approvals,
manager saw both notifications without reply/approval controls, and personal
acknowledgement cleared unread/notification state. Three inbound interactions
remained unchanged and no outbound interaction was created. Temporary preview and
session helper stopped. Prior intake browser checks also confirmed late-arrival
history, owner customer/vehicle confirmation, stale-vehicle denial and manager
read-only access; full responsive/accessibility acceptance remains outstanding.

This does not complete milestone 4. Independent email notification delivery,
provider-threaded email, trusted service-reply proof issuance, quiet hours/digest/
retry handling and actionable uncertain-delivery reconciliation remain gaps.
Manager email delivery is explicitly disabled pending provider choice and separate
activation approval. See docs/architecture/WHISPER_INBOX.md for exact boundaries
and commands. Only local commits in this task; no push, merge, deployment, shared
Supabase or real provider activity. Founder main remains at 20e153a and CONTEXT.md
retains its approved hash. Additional concurrent UI edits were observed in the
original checkout; none were made, reset, copied or changed by this task.


[AI: codex] [DATE: 2026-10-05] [AREA: platform] [STATUS: done]
Added exact-context Whisper service-reply review using existing Approvals and the
existing durable send executor. The immutable staging command anchors the precise
owned inbound interaction, channel and canonical recipient; an explicit owner
review signs that action and inbound content/time fingerprint with the outbound
message. Later messages cannot substitute context; changed or unavailable evidence
fails closed. Marketing defaults and STOP/DNC/suppression/policy checks remain.
No new settings screen, provider adapter or automatic purpose classification.

Consumed proof claims now hold inbox work even after pending-status rollback or
operator completion. Approvals replaces send/edit controls with a read-only delivery
review and manual reconciliation guidance. Purpose/edit actions refuse spent or
unverifiable claims. This does not record reconciliation resolution or query provider
activity: uncertain delivery stays held, and no automatic replacement is sent.

Migration 84 initialized from zero on the dedicated unlinked disposable database.
The initial PL/pgSQL CASE comparison needed parentheses; the corrected migration
applied successfully. An added test incorrectly tried to deactivate an owner; the
existing constraint rejected it. The test now verifies that protection without
changing the constraint. A subsequent concurrent-execution assertion failed during
a slow overlapping local preview run; final isolated rerun results follow below.

Local browser acceptance used a fictional shop and outbound-denied runtime: staged
one SMS draft, displayed its exact inbound evidence, reviewed purpose without
sending, then simulated a durable claim directly in the disposable fixture. The
approval page showed the read-only uncertain-delivery panel with no send/edit
controls. Three inbound interactions remained and zero outbound interactions were
created. Task preview/session helper stopped. SMS and email automated coverage
includes mismatched/expired/forged proofs, changed context/destination, lookup/claim
failure, consent overrides, concurrent execution, retries and persistent holds.

True provider-threaded email, independently delivered manager notifications,
quiet-hours/digest/retry workers, persisted reconciliation decisions and full
responsive/accessibility acceptance remain milestone gates. Cursor's separate UI
polish worktree was not edited. No push, merge, deployment, shared database or real
provider activity. Founder main remains at 20e153a and the approved CONTEXT.md hash
is unchanged; concurrent original-checkout UI edits remain untouched by this task.

Final Node 22.23.2 verification: 1,169 unit passes in 105 files with four existing
intentional live skips; 338 integration passes in 33 files, zero skips (47.53s).
All 16 exact-context integration cases passed without changing timeouts or skipping
coverage. The overlapping-run assertion failure could not be reproduced after
stopping the preview; its precise underlying error was not retained, so it is not
claimed as a proven timeout diagnosis. Failure diagnostics now include executor
results. Full lint, offline production build and post-build typecheck passed.
Exact 84-version ledger, RPC/table grants, four Whisper and two intake relationships,
all 26 original tenant definitions, tenant/photo refusal probes and atomic record
rollback passed. No inconsistent data was repaired. Changed-file credential,
runtime-artifact, machine-path and whitespace scans passed.

Commands: Node 22 `node scripts/isolated-check.mjs unit`, `integration --fresh`,
`lint`, `build`, then `types`; `python3 scripts/verify-whisper-migration.py`,
`python3 scripts/verify-intake-vehicle-migration.py --fresh`,
`python3 scripts/verify-agent-record-migration.py --fresh`; original tenant/photo
verifiers redirected in memory only to unlinked gradia-record-fresh; `git diff
--cached --check`. Fresh initialization used `supabase --workdir
.local-tools/record-fresh db reset --local --no-seed` and the three disposable
failure fixtures. Build warnings about existing Sentry configuration/source maps
remain; OS egress denial and absent provider credentials prevent external delivery.

Implementation commit: `4a95652` (11 implementation/test/migration files); this
verification update changes two documentation files, for 13 files in the slice.


[AI: codex] [DATE: 2026-10-06] [AREA: platform] [STATUS: done]
Added persisted owner delivery reconciliation to the existing approval record, the
next bounded Whisper milestone-4 slice. Owners record delivered, not-delivered or
still-uncertain assessments with evidence notes. These are human reports, not
provider-verified receipts. Paginated append-only history preserves each decision,
actor/name snapshot, timestamp and reviewed execution state. No new settings screen,
Agent memory publication, provider lookup or delivery worker.

The session-only SQL command checks live owner authority, tenant-bound consumed
proof, expected revision and provider-completion timestamp. Exact retries dedupe;
competing/stale decisions and changed command reuse fail closed. Anonymous, manager,
staff, revoked-member and sessionless service callers are denied. All direct table
privileges are revoked, including service role. Recording any outcome changes only
the review history: it cannot release a proof, edit/retry the message, clear the
conversation hold, grant consent or authorize a replacement. Historical reviews and
spent authority survive pending-action deletion. No existing deletion behavior changed.

Migration 85 initialized from zero on unlinked gradia-record-fresh. All 85 ledger
versions, new RPC grants/RLS/composite proof relationship, existing four Whisper/two
intake relationships, original 26 tenant definitions and tenant/photo refusal plus
atomic-record rollback probes passed. Node 22: 1,176 unit passes in 106 files with
four existing intentional live skips; 347 integration passes in 34 files, zero
skips. Seven new unit and nine new integration cases cover validation, no retry,
history escaping/pagination, tenant/role/direct-access denial, independent-session
command dedupe, concurrent/stale decisions, late provider-completion changes and
retained history. Lint initially caught JSX inside a try/catch; the database catch
was narrowed, and full lint, offline build and post-build types passed without
weakening the rule.

Browser acceptance used a fictional owner/shop and consumed-action fixture on an
outbound-denied local runtime. One still-uncertain assessment appeared in attributed
history; pending state and consumed proof remained unchanged. Three inbound
interactions remained; no outbound interaction was created. Temporary preview and
session helper stopped. Final unit and typecheck were repeated after browser work.
Credential/runtime/machine-path and whitespace scans passed for the changed files.
Commands remain the Node 22 isolated-check unit, integration --fresh, lint, build,
then types commands and disposable catalog/refusal commands documented above.

Still outstanding: provider-evidence lookup, separately authorized replacement
handling, delegated manager reconciliation, provider-threaded email, independent
manager notification delivery/digest/quiet-hours/retry workflow, and full responsive
and accessibility acceptance. Human review does not clear the delivery hold. No
push, merge, deployment, shared Supabase or real provider activity. Founder main and
CONTEXT.md are protected; concurrent founder-checkout edits were not touched. The
separate Cursor UI-polish worktree was not changed by this task.

Implementation commit: `0847317` (nine implementation/test/migration files), plus
two documentation files in the verification commit: 11 files for this slice.


[AI: cursor] [DATE: 2026-10-05] [AREA: platform] [STATUS: done]
Polished the existing Whisper list, thread, loading state, and controls on
`codex/cursor-whisper-ui-polish` for phone, tablet, and desktop reading, keyboard
focus, labels, and error or status text. Permissions, command IDs, revisions, and
approval staging were left in place. Node 22 isolated unit result: 1,169 passed
and 4 skipped; lint, offline build, and post-build types passed. A fictional
static fixture was checked at 320, 390, 768, and 1280. Authenticated browser
sessions were not run. See docs/qa/WHISPER_UI_ACCEPTANCE.md. Local commit only;
no push, merge, deployment, shared database, or provider activity.


[AI: codex] [DATE: 2026-10-07] [AREA: platform] [STATUS: done]
Consolidated committed policy, intake/vehicle, Whisper, threaded email, disabled
manager notification and Cursor polish work on codex/mvp-consolidation-2026-10-07
(PR #51), with current documentation and historical PR branches. Resolved doc
conflicts without restoring the superseded voice-first scope. Updated email reply
wording to reflect trusted-thread requirements. Added docs/HANDOFF_CURRENT.md for
separate Cursor UI and Claude Code backend lanes. User explicitly authorized
push/merge. Git automatic deployment is disabled in vercel.json; this entry does
not claim deployment or pilot acceptance. Original founder and backend dirty trees
are untouched; snapshot branches preserve both for UI follow-up. Billing PR #38
remains separate because its free trial/tier assumptions need reconciliation.

Node 22 isolated verification: 1,232 unit passes with four existing live skips,
362 integration passes with zero skips, lint, offline webpack production build and
post-build typecheck passed. All 87 migrations initialized from zero on the unlinked
gradia-record-fresh disposable stack with four test-only fixtures. Whisper/intake
catalog and atomic-record rollback probes passed. The final copy-only correction
passed all 11 Whisper UI tests. Credential-pattern scans of new commit diffs passed.
GitHub required checks must pass before merge; no shared database, real provider,
production write guard or live channel was changed. Historical source ledgers retain
their original dates; the new handoff identifies the assembled baseline.


[AI: codex] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Built the public website intake backend on codex/public-form-intake, independently
of Cursor's layouts and Claude Code's delegated reconciliation. Owner-session form
configuration binds an immutable public form UUID to one shop and exact HTTPS origin.
The public JSON route bounds streamed bodies, rejects caller tenancy/thread/consent,
and returns only generic acceptance. Database submission rechecks enabled binding,
serializes owner changes and shop-wide rolling quotas, dedupes exact retries and
refuses changed content. Inquiry evidence enters existing identity review; no CRM
identity, consent, outbound action or provider effect is inferred. No setup UI was
added; its contract and remaining activation/browser/anti-bot gates are documented
in docs/architecture/PUBLIC_FORM_INTAKE.md. All original worktrees are untouched.

Node 22: 1,246 unit passes (four existing intentional live skips), 369 integration
passes (zero skips), lint, offline production build and post-build typecheck passed.
All 88 migrations initialized on the new unlinked gradia-public-form-tests stack at
57331; this deliberately avoids the other agents' disposable stacks. Form catalog,
RPC ACL/fixed-search-path, three new relationships and injected intake rollback
probes passed. The existing 26 tenant definitions, inconsistent tenant/photo refusal
and team audit rollback probes also passed on that dedicated stack. Network guards
permit only its exact loopback origin and sentinel when explicitly selected with
--forms. Service-role importer inventory records the new database-bound public route.

Initial verification caught a missing local test-port allowlist, the required
service-importer inventory entry, a test-only TypeScript inference issue and a fixture
that incorrectly tried to deactivate an owner (forbidden by an existing invariant).
Fixed the harness/type issue, reviewed/registered the importer, and tested manager
revocation plus form disablement without relaxing owner protection. No production
migration, deployment, provider activation, real visitor or live model call occurred.


[AI: claude-code] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Added the first delegated manager operation on `codex/claude-backend-next`: an owner
can grant a manager `delivery.reconcile` (valid only with `crm.read`) to record
delivery assessments on held sends. Migration 88 adds the constrained grant, a
reviewer-role column, a private live-authority helper, delegated authority in the two
existing reconciliation RPCs and a session-only `list_delivery_holds` read. Added
`/team/delivery-reviews` as a minimal surface reusing the existing history and form.
Shared contract changes Cursor should know: `TEAM_CAPABILITIES` has a fifth entry (it
appears in the team grant checkboxes), `DeliveryReconciliationHistory` takes an
optional `pageHref`, history items carry `actor_role`, and outcome labels are now
role-neutral.

Left alone: `claim_control_action` and all approval, edit, reject and reply staging
remain owner-only. Reviews still release no proof, clear no hold and authorize no
resend. No notification, provider or transport code changed.

Node 22.23.2 isolated runner on unlinked `gradia-record-fresh`: 1,235 unit passes
with four existing live skips; 369 integration passes, zero skips; lint, offline
build and post-build types passed; 88 migrations from zero with exact ledger; all
existing catalog, relationship and refusal probes passed. The new page was not run
in an authenticated browser. Details and limits are in
`docs/architecture/WHISPER_INBOX.md`. Committed as `23f2932` and pushed for review
as a pull request at the founder's request. No merge, deployment, shared database
or provider activity. This worktree's
dependencies were installed with `npm ci`, and the disposable stack was reset.


[AI: codex] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Reviewed Claude Code's delegated delivery review PR #54 and merged it after both
required checks passed (one database-startup failure passed on retry). Integrated
that main into public form PR #55; the only source conflict was the append-only work
log, and both histories were retained. Combined Node 22 verification: 1,249 unit
passes (four existing live skips), 376 integration passes (zero skips), lint,
offline build and post-build types passed. All 89 migrations initialized from zero
on the dedicated form stack. Public form and updated Whisper permission/relationship
probes passed together. Updated the current handoff with the public form backend
and remaining setup UI. No Cursor/Claude checkout, shared database or production
configuration was modified; Git deployments remain disabled.


[AI: claude-code] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Added delegated manager approval of queued texts and emails on
`codex/claude-delegated-message-approval`, stacked on PR #54. The founder chose
messages only for this slice. Migration 90 adds the `approvals.messages` grant (valid
only with `crm.read`), moves the claim body into a private `control_claim`, adds a
session-only `claim_delegated_message` bound to the reviewed payload hash, records
`actor_role` on every execution decision, and adds a session-only
`list_delegated_message_approvals` read. `executeApproval` gained a delegated option
that claims on the manager's session and then runs the unchanged send executors with
shop-scoped service access. Added `/team/approvals` and `approveDelegatedMessage`.
Shared contract changes Cursor should know: `TEAM_CAPABILITIES` has a sixth entry,
and the team grant help text now describes message approval truthfully.

Left alone: the owner claim path and its grants, send policy, consent, proof and
purpose review, and every non-message action type. Managers cannot edit, reject or
stage. `eval/tenant-scoping.test.ts` gained one reviewed service-client importer
with its justification; no locking test was weakened.

Node 22.23.2 isolated runner on unlinked `gradia-record-fresh`: 1,248 unit passes
with four existing live skips; 390 integration passes, zero skips; lint, offline
build and post-build types passed; migrations from zero with exact ledger; new
and existing catalog, rollback and refusal probes passed (final counts after the
main merge are in the Control Center ledger). Transports were mocked;
the page was not run in an authenticated browser. Found and left for a separate
task: no migration adds `create_quote` to `pending_action_type`. Details and limits
are in `docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md`. Pushed for review as a
pull request at the founder's request; no merge, deployment, shared database or
provider activity.


[AI: claude-code] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Added delegated manager rejection of queued texts and emails on
`codex/claude-delegated-message-rejection`, stacked on PR #56. The existing
`approvals.messages` grant now covers declining as well as approving. One migration
adds a session-only `reject_delegated_message` bound to the reviewed payload hash;
it audits the reviewer, sends nothing, consumes no authority and refuses messages
whose sending was already claimed. Added `rejectDelegatedMessage` and a reject
button beside approve on `/team/approvals`; the grant label and help text now say
"approve or reject".

Left alone: the owner reject and undo paths, the executor, send policy and every
non-message action type. No service client is used for rejection.

Node 22.23.2 isolated runner on unlinked `gradia-record-fresh`: 1,271 unit passes
with four existing live skips; 402 integration passes, zero skips; lint, offline
build and post-build types passed; 91 migrations from zero with exact ledger; all
catalog, rollback and refusal probes passed. Not run in an authenticated browser.
Details are in `docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md`. Pushed as a
pull request; no merge, deployment, shared database or provider activity. The
`create_quote` enum fix is separate, in PR #57.


[AI: claude-code] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Fixed a schema gap on `fix/create-quote-action-type`: no migration added
`create_quote` to `pending_action_type`, so the voice receptionist's draft-quote
proposals failed at staging on any database built from the repository, while the
executor and policy adapter already handled the type. Added
`20261008170000_create_quote_action_type.sql` (one idempotent `ADD VALUE IF NOT
EXISTS`) and three integration cases: staging as the voice tool does, owner approval
producing a menu-priced draft that is never sent, and no automatic claim even under
a policy that grants quote autonomy. No application code changed.

Whether production already carries the value by hand was not checked; the
migration is safe either way. Node 22.23.2 isolated runner on unlinked
`gradia-record-fresh`: 1,249 unit passes with four existing live skips; 379
integration passes, zero skips; lint, offline build and post-build types passed; 90
migrations from zero with exact ledger. Its timestamp follows PR #56's migration, so
merge #56 first to keep ledger order. Pushed as a pull request; no merge,
deployment, shared database or provider activity.

[AI: cursor] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Reconciled the saved app-shell and two-pane inbox from
`codex/wip-inbox-layout-2026-10-07` onto `codex/cursor-ui-next` without
bulk-copying that snapshot. Conversations now use the shared shell in a
flush layout: at the large breakpoint the list stays beside the open
thread, and on a narrow screen the list hides while a thread is open.
Ask Gradia sits in the center of the top bar from that breakpoint up so
it does not share a cluster with help. The list query lives in
`src/app/conversations/load-inbox.ts`. Message history still uses `page`;
the list window uses `list`, so older messages do not page the list.
Deliberately not copied: the WIP nav regroup and Inbox rename (the
documented order stays Home, Approvals, Activity, Conversations), the
dense list with color-only unread and local times, client-side channel
filters, the WIP control rewrite, and its older email wording. Permissions,
exact reply context, durable command IDs, uncertain-delivery holds, and
the mailbox-thread hold sentence stay on the current controls. A skip
link rule was added because utility order was keeping the link off-screen
when focused. Node v24.15.0 vitest: `eval/whisper-inbox-ui.test.ts`, 13
passed. Browser acceptance used a disposable local dev server and fictional
fixtures, not a signed-in shop: desktop 1920, phone 390 and 320; list,
thread, hold, email, staff, failed load, empty page, and unavailable
thread. A reply was typed and not submitted. The embedded browser did not
move focus on Tab; click focus and the Back link navigation did work.
Missing Supabase env blocked a real owner session on `/conversations`.
No shared action contract changed. `vercel.json` deployment stays disabled.
Nothing committed, pushed, or deployed.

[AI: codex] [DATE: 2026-10-08] [AREA: platform] [STATUS: review]
Preserved Cursor's uncommitted inbox-shell reconciliation in the separate
`worktrees/oct8-integration` checkout. The Cursor and stale platform checkouts
remain unchanged. Reviewed the list/thread pagination, permission boundaries,
delivery-hold copy and unchanged reply controls. Fixed two React createElement
test calls with a required children default and positional rendered children;
the initial typecheck caught missing props despite the unit tests passing. CI
then caught a lint conflict in the first fix; targeted tests, lint and types
passed again after correcting it. On main including PR #56: 1,264 unit
passes (four existing skips), 13 targeted inbox tests, full lint, offline Node 22
build and typecheck passed. Keep this UI PR draft pending signed-in owner/manager/
staff browser acceptance and real keyboard focus/skip-link testing; Cursor's
fixture-only responsive checks do not cover the usage/setup pills.

Read-only service inspection: both Supabase projects report INACTIVE. Vercel's
platform overview shows a Ready production deployment dated September 24. Project
settings offer Pause Project, confirming it is not paused. The public URL returns
HTTP 403 and automatic Git deployments remain disabled in
vercel.json. The CLI API returned 403; deployment evidence came from the signed-in
Vercel dashboard. No service was resumed, production migration run, provider
activated or deployment created. Database ledger and write-guard inspection must
precede a separately planned production release.


[AI: codex] [DATE: 2026-10-08] [AREA: platform] [STATUS: done]
Reviewed and merged Claude Code PRs #56, #58 and #57 in that order, waiting for
both protected checks at each merge. Retargeted #58 to main and updated both
remaining branches to the latest main before CI. Preserved both sides of the
append-only work-log conflicts. Main now contains 92 migrations and the quote
enum fix together with manager message approval/rejection. No shared database
migrations or deployments occurred. Updated draft UI PR #59 to this main; its
authenticated browser and keyboard acceptance remain outstanding.

[AI: cursor] [DATE: 2026-10-10] [AREA: platform] [STATUS: done]
Closed draft PR #59's signed-in owner/manager/staff/revoked keyboard gap on
`codex/cursor-component-polish` using the existing disposable preview
(launcher 3128, app 3127). Did not start a second Next server and did not
touch Codex 3109/3110. Presentation-only: shell skip link, `:focus-visible`
on skip links, labelled handoff selects, focusable list/thread headings,
`RouteFocus` after in-app navigation, and a scrollable thread column so
Refresh is not clipped. Extended `eval/whisper-inbox-ui.test.ts`. Wrote
`docs/design/ROUTE_INVENTORY_2026-10-09.md` (every `src/app/` route still
`pending` for the later component slice) and a 2026-10-09 section in
`docs/qa/WHISPER_UI_ACCEPTANCE.md`. Screenshots under
`docs/qa/screenshots/2026-10-09/`. No server actions, RPCs, migrations, or
query semantics. No push or new PR. Remaining: live Tab paint in a focused
OS window, Jordan email thread read still unavailable, sidebar hydration
warning, team chrome without the shell skip link, contrast/200% zoom, and
the token/component pass.

[AI: cursor] [DATE: 2026-10-10] [AREA: platform] [STATUS: review]
Finished the first visual slice on `codex/cursor-component-polish` without
starting over. Semantic tokens in `globals.css` now match the founder
charcoal / silver / violet table. Shared wrappers added: ErrorState,
ListToolbar, Pagination, FormField, DetailSection. Reused SectionHeader
(action slot), EmptyState, StatusPill, Skeleton, AppShell, inbox frame,
and existing Base UI / shadcn buttons. No community installer. Home now
states channel readiness with StatusPills and drops “agents watching”;
KPI sparklines stay off. Conversations keep #59 panes, reply context,
command IDs, holds, and disabled submissions — restyle only. Customers
is presentation: labelled shop search, quiet card edges, DetailSection
on the record. Disposable preview reused launcher 3128 / app 3127; Codex
3109/3110 left alone. Owner demo: Home, Conversations list + Alex SMS
thread (typed a reply, did not queue), Customers list + Alex detail.
No page overflow at 320/390/768/1440/1920. After shots in
`docs/qa/screenshots/2026-10-09/`. Touched tests: 27 passed
(`design-tokens-2026-10-09`, `whisper-inbox-ui`, `perf-001`). Full lint
passed. No server actions, RPCs, migrations, or query changes.
`vercel.json` deployment stays disabled. Remaining: later inventory PRs,
SkipLink hydration warning, Jordan email thread read, live Tab paint in
a focused OS window, 200% zoom / measured contrast, team chrome without
the shell skip link.

[AI: cursor] [DATE: 2026-10-10] [AREA: platform] [STATUS: review]
Closed the first-slice leftovers on `codex/cursor-ui-a11y` (stacked on
#63). NavRow dropped the Framer Motion rail morph that mismatched
server/client markup. Team pages share the shell skip link via TeamChrome.
Skip link becomes visible on `element.focus()`. Command bar restores
focus to the opener. Measured contrast is in
`docs/qa/CONTRAST_2026-10-10.md`; 200% (960 CSS px) Home and Conversations
had no page overflow. Jordan email thread read stays a fixture/backend
block. Reused 3128/3127; did not touch 3109/3110. No server actions,
RPCs, migrations, or query changes.

[AI: cursor] [DATE: 2026-10-10] [AREA: platform] [STATUS: review]
Approvals and Activity presentation on `codex/cursor-ui-approvals`.
Owner queue keeps Send / Tweak / Drop at equal weight and the same
actions. Delegated `/team/approvals` uses ReviewCard with approve-and-send
as the one filled primary and reject as outline. Activity chips say they
filter the loaded page only. No server actions, RPCs, or query changes.

[AI: cursor] [DATE: 2026-10-10] [AREA: platform] [STATUS: review]
Team and Settings presentation on `codex/cursor-ui-settings`. Team workspace
selector, member/grant forms, assigned list, and delivery-review evidence use
the shared tokens and wrappers. Settings, Control Center, and receptionist
use SectionHeader / StatusPill / skip; billing is layout-only with the same
$20 / +$29 copy. Owner + manager spot-check on 3128/3127. Touched tests 44
passed. No server actions, RPCs, migrations, or query changes. vercel.json
deployment stays disabled. Codex 3109/3110 left alone.

[AI: cursor] [DATE: 2026-10-12] [AREA: platform] [STATUS: review]
Intake review and login/onboarding presentation on `codex/cursor-ui-settings`
(this worktree; PR branch `codex/cursor-ui-intake`). Restyled existing
`/intake` and `/intake/[workflowId]` with TeamChrome, ReviewCard, StatusPill,
ListToolbar, Pagination, FormField, EmptyState, ErrorState, and loading/error
siblings. Wired only `linkIntakeIdentity` and `linkIntakeVehicle`. Owner
customer search is the existing `search_intake_customers` RPC and is labelled
as linking help, not a queue filter. Staff and revoked see unavailable.
Login got labelled FormField, field errors, and 44px targets; onboarding got
an accessible stepper, field errors, and 44px actions. Auth, redirect,
provisioning, billing, and `$20` / `+$29` copy are unchanged.

No qualification library exists in this checkout (Claude owns that backend).
No reject/defer/dismiss intake actions exist — did not invent them. Did not
resolve identity in the UI, auto-create customers, record consent, start
nurture, send messages, or call public-form submit. Ask: this fixture shows
one unidentified Whisper interaction but zero `list_lead_intake_review` rows;
if qualification is persisted on another branch, it still needs a contract
before a review screen can call it.

Reused launcher 3128 / app 3127. Did not touch Codex 3109/3110. Owner empty
queue, Home compact intake, onboarding hours step, staff/revoked unavailable.
Viewports 320/390/768/1440/1920: no page overflow. Signed-in `/login`
redirected to `/dashboard` (unchanged). Touched tests 49 passed; lint on
touched files passed. Screenshots in `docs/qa/screenshots/2026-10-12/`.
`vercel.json` deployment stays disabled. SkipLink hydration warning remains.
[AI: codex] [DATE: 2026-10-09] [AREA: platform] [STATUS: done]
Prepared the founder-requested UI/component handoff for Cursor, with a charcoal,
silver and violet semantic palette, source links to 21st.dev/shadcn/Base UI/Origin
UI, route inventory requirements and staged browser acceptance. These are fit-based
references, not a claimed global ratings ranking. Created the separate
cursor-component-polish worktree from PR #59, and claude-qualification from main;
the latter has a bounded durable-qualification backend brief. Original agent
checkouts and the running local preview remain untouched. Briefs are in docs/handoffs.
They are ready for the founder to pass to those external agents; no external agent
was started or messaged by this change.

Completed the independent channel-evidence fix in whisper-summary.ts: recorded
inbound counts now produce a neutral fixed-vocabulary activity fact instead of
inventing a stated customer preference. Ties retain all channels, invalid counts
and unknown labels are omitted, and the model prompt explicitly forbids converting
history into preference or contact permission. Deterministic do-not-contact output
is preserved. Nine focused tests and 1,275 full unit tests pass (four intentional
live skips), along with targeted lint and TypeScript. No provider call, schema,
permission, deployment or shared-database change. Live-model fidelity remains an
evaluation requirement; prompt wording is not a deterministic output guarantee.


[AI: claude-code] [DATE: 2026-10-09] [AREA: platform] [STATUS: done]
Built durable lead qualification persistence on `codex/claude-qualification`, per
`docs/handoffs/CLAUDE_QUALIFICATION_2026-10-09.md`. Inspected first: no existing
structure held structured, reviewed qualification (`lead_workflows` carries identity
only; `leads` carries a stage and free text). Migration 93,
`20261009100000_lead_qualification.sql`, adds one record per intake workflow and an
append-only audit, reachable only through four session-only RPCs (read, list,
history, update). The record stores requested service, reported vehicle condition,
timing, location, constraints and open questions with explicit unknown/reported/
confirmed status and per-field provenance. It stores no customer or vehicle of its
own: saves are bound to the workflow's reviewed links and evidence, and reads report
`needs_review` when any of those change. Added the owner-granted `leads.qualify`
capability (off by default, valid only with `crm.read`); reading reuses `crm.read`.
Added `src/lib/lead-qualification.ts`, read helpers, the `updateLeadQualification`
action, a catalog probe and the UI contract in
`docs/architecture/LEAD_QUALIFICATION.md`.

Left alone: intake functions, workflow states and transition reasons, the customer
merge, the executor, policy, globals.css, shared UI components, whisper-summary.ts
and Codex's preview. No UI, no model or provider call, no nurture or scheduling.
Shared contract change Cursor should know: `TEAM_CAPABILITIES` has a seventh entry,
so the team grant checkboxes show it.

Node 22.23.2, isolated runner, unlinked `gradia-record-fresh` only; the public-form
stack at 57331 was not touched. 1,302 unit passes with four existing live skips
(112 files; 31 new); 424 integration passes, zero skips (39 files; 19 new); lint,
offline production build and post-build typecheck passed. All 93 migrations applied
from zero with exact ledger. The new probe and the Whisper, delegated-approval,
intake-vehicle, agent-record, team, tenant (26 relationships), photo,
control-policy and control-execution probes passed. New integration coverage: two-
shop isolation and foreign customer/vehicle/service references; owner, delegated
manager, read-only manager, assigned staff, revoked, foreign, anonymous and service
callers; 39 malformed documents each refused with its path; unknown versus reviewed
completeness; evidence reopen, vehicle edit, merge and customer deletion; concurrent
edits, exact replay and changed-command refusal; injected audit failure rolling back
first save and later edit; and zero change to customers, vehicles, leads, quotes,
appointments, pending actions, interactions, consent, intake or usage tables. One
test-only type error was fixed after the first post-build typecheck; no assertion
changed.

After merging `main` (PR #60, no migrations) the full gate was rerun: 1,306 unit
passes, lint, offline build and post-build types passed. The full integration suite
then passed once (424 of 424) and failed in four further runs with one to three
failures each, in different files every time (booking, conflict, intake, quote,
team). Every failing run logged local gateway 502s ("invalid response from the
upstream server"; Kong reported connection resets from the API container), and each
affected file, and the new qualification file, passed when run on its own. The
Docker VM was at about 6.5 of 7.75 GiB across 64 containers, with another stack's
analytics container being OOM-killed in a loop. This is recorded as an unresolved
local-environment instability, not as a clean repeated pass; GitHub's `integration`
check is the clean-environment run for this PR. Only this stack's own API container
was restarted; no other stack was stopped or reset. Not applied to any shared database; no deployment setting changed. This is
persistence, not a working nurture-to-book loop.


[AI: codex] [DATE: 2026-10-09] [AREA: platform] [STATUS: done]
Completed two bounded public-intake tasks, isolated from Cursor's component pass
and Claude's qualification backend. First, the anonymous form body reader now has
a ten-second total deadline and abort handling, returning a generic CORS-compatible
408 before any submission RPC. Oversize and stalled streams no longer wait for an
uncooperative cancellation hook. Second, added an immutable browser inquiry helper
that snapshots validated content with one UUID, shares concurrent attempts, keeps
manual retry bytes identical, caches confirmed acceptance and labels unconfirmed
outcomes honestly. It omits credentials, refuses redirects, has a twenty-second
whole-attempt deadline and never retries automatically. The UI integration contract
and reload/uncertainty limits are documented in PUBLIC_FORM_INTAKE.md.

Node 22 verification: 1,295 unit passes (four existing live skips), full lint,
offline build and post-build typecheck; seven public-form integration passes on
the unlinked local form stack, using test-owned records without resetting it.
No migrations, production configuration, live provider calls or UI changes.
The local preview and other agent worktrees remain unchanged. This does not replace
public-origin browser/anti-bot acceptance or implement the pending form setup UI.
Also merged PR #60 after both required GitHub checks passed.

[AI: codex] [DATE: 2026-10-09] [AREA: platform] [STATUS: done]
PR #61's remote checks exposed a prefer-const lint failure for the body deadline
timer despite the prior local lint result. Changed the single-assignment timer to
const; targeted lint and the 34 public-form unit tests pass. Pushed the correction
for fresh CI. No runtime contract or other agent checkout changed.


[AI: claude-code] [DATE: 2026-10-10] [AREA: platform] [STATUS: done]
Fixed the activity feed reporting unconfirmed work as done, on
`fix/unresolved-delivery-visibility`. Reproduced on the Cursor preview fixture
(read-only): a `send_sms` action with status approved, no result and no claim was
shown on Home as "Texted a customer — Handled". `src/lib/data/activity.ts` now
derives each action's outcome from `result_id` and the consumed sending claim, with
a new `unresolved` outcome titled "… — delivery not confirmed" that links to the
action's approval record. A failed claim lookup leaves messages unresolved. The
Approvals "completed agent actions" list applies the same rule. `activity-feed.tsx`
gained the "Not confirmed" pill and no longer falls back to "Handled" for an
outcome it does not recognise; `strings.ts` gained two labels.

Investigated the Jordan email thread that rendered "unavailable". The read is
correct for owner and manager and renders on every repeat load. The preview gateway
logged one `502` on that read during the acceptance session; the page presents any
failed read as an access problem. No code change for this: the thread page is being
rewritten in the open UI PR. Finding and suggested wording are in
`docs/architecture/WHISPER_INBOX.md`.

Shared contract changes Cursor should know: `ActivityOutcome` has a fourth value,
`unresolved`; `STRINGS.pages.activity` gained `outcome.unresolved` and
`reviewResult`; `activity-feed.tsx` changed in the pill and link label only.

Node 22.23.2 isolated runner: 1,348 unit passes with four existing live skips
(22 new); lint, offline production build and post-build typecheck passed. No
migration, RPC or executor change, so the database integration suite was not rerun.
Not viewed in a browser. The preview database was only read, inside read-only
transactions and through its own sign-in helper; nothing was written or reset.
[AI: codex] [DATE: 2026-10-10] [AREA: platform] [STATUS: done]
Integrated PR #59 with main 3487600 in a separate detached worktree. Only the
append-only work log conflicted; both sides were retained. Reconciled head edc3259
passed 1,328 unit tests (four intentional live skips), lint, offline Node 22 build,
post-build typecheck and both required GitHub checks. Merged #59 as fd46f24.
Integrated Cursor PR #63 with that baseline in another separate worktree; only
the append-only log conflicted. Its combined application tree passed 1,331 unit
tests (four intentional live skips), full lint, offline production build and
post-build typecheck. The final main merge had no file changes. Retargeting #63
to main for required CI before merge. No original agent checkout was modified.

Local Cursor owner preview loads the styled Home and inbox. Its recorded
owner/manager/staff/revoked and responsive checks remain supporting evidence;
live keyboard-focus paint, 200% zoom/contrast and the reported hydration warning
remain acceptance follow-ups, not claimed passes. Email fixture thread read and
Activity labeling an unconfirmed execution as handled are existing data-path
issues outside these presentation diffs; they remain open backend follow-ups.
No full pilot acceptance, shared migration, deployment or provider activation.
Git deployments remain disabled.

[AI: claude-code] [DATE: 2026-10-12] [AREA: platform] [STATUS: done]
Added a read-only "next qualification question" suggestion on
`auto/qualification-next-question` (from main 1cacb18), in the
`claude-qualification` worktree. `proposeNextQualificationQuestion` in
`src/lib/lead-qualification.ts` picks the first missing item in a fixed order
(service, vehicle link, timing, condition, location, constraints, then the
reviewer's own open question) and returns fixed wording with the record revision it
was derived from; `loadNextQualificationQuestion` in
`src/lib/data/lead-qualification.ts` derives it from one `read_lead_qualification`
call. A record in identity review or no longer current yields no suggestion. Nothing
is stored, staged as an approval or sent; no model, provider, migration, RPC,
capability or screen. Contract: "Next question suggestion" in
`docs/architecture/LEAD_QUALIFICATION.md`.

Isolated runner on Node 24.15.0 (not the usual Node 22): 1,367 unit passes with four
existing live skips (10 new), lint and typecheck passed. Build and the database
integration suite were not run: no migration, RPC or route changed. Committed as b76ca4d; not viewed in a browser, since no screen uses it yet.
The stale `platform` checkout and every other worktree were left alone.
[AI: codex] [DATE: 2026-10-10] [AREA: platform] [STATUS: done]
Completed the bounded inbox load-error follow-up while integrating #64–#67 in
separate checkouts. Only SQL permission refusal 42501 renders access guidance;
other read failures and malformed responses offer a refresh without claiming
an empty thread or a permission problem. Invalid identifiers still skip the RPC,
raw error details stay hidden, and failed loads expose no mutation controls.
Seven new route-level regressions cover these cases; combined unit suite passed
1,364 tests (four intentional live skips), lint, offline Node 22 production build
and post-build typecheck. The build caught an accidental extra presentation prop
on the controls component; it was removed and the build/types passed afterward.

A separate local production-build preview at 3130 uses only the existing disposable
Cursor database at 58331, with provider egress denied. Browser review confirmed the
unknown-delivery fixture now reads Not confirmed with its review link; Jordan's
email thread rendered its message and reply-context hold wording. No action was
submitted; no fixture/schema reset or other agent checkout change. No browser
errors were captured on those loads. Added next-lane briefs for Cursor's usable
qualification review UI and Claude's read-only next-question proposal. These briefs
have not been sent to either agent. Deployment requested by founder but currently
blocked by invalid Vercel CLI authorization and inactive Supabase; no production
migration, write-guard removal, provider activation or deployment was performed.


[AI: codex] [DATE: 2026-10-12] [AREA: platform] [STATUS: in-progress]
Resumed integration after the founder status request. PRs #64 and #65 were merged;
#66 passed both required checks and merged as 8b31c47. Retargeted #67 to main and
pushed its reconciled head for fresh CI; only the append-only work log conflicted.
The Activity reconciliation retains both Cursor's toolbar and Claude's unresolved
outcome rendering. Vercel CLI login has been restored and verified; the Supabase
project zfxkzciumhrrgfeacwds remains INACTIVE. No deployment or shared migration.
The next-lane handoff now reflects this remaining blocker.


[AI: codex] [DATE: 2026-10-12] [AREA: platform] [STATUS: done]
Finished integrating #64, #65, #66 and #67 with both protected checks green before
each merge. Latest main is 1cacb18 (merge #67). Each integration check passed all
424 database tests. The combined application source matches the already-validated
local production build. No other agent worktree was changed. Preparing the separate
thread-load error PR from this merged baseline; deployment remains unperformed
while Supabase is inactive.

[AI: claude-code] [DATE: 2026-10-12] [AREA: platform] [STATUS: done]
Claude lane of `docs/handoffs/NEXT_LANES_2026-10-10.md`: a read-only next-question
proposal from the persisted qualification record, on
`auto/qualification-next-question` from main c350573, in the `claude-qualification`
worktree. `proposeNextQualificationQuestion` (`src/lib/lead-qualification.ts`) and
`loadNextQualificationQuestion` (`src/lib/data/lead-qualification.ts`) reuse the
existing `read_lead_qualification` loader and its authority. Order: review
requirement when identity or evidence needs review; the reviewer's first open
question verbatim; the first unknown of service, vehicle condition, timing, location,
constraints; an unconfirmed vehicle link reported as a review requirement; otherwise
complete. Every reply carries the qualification and evidence revision it came from.
Fixed wording; a known empty constraint list is an answer. Nothing is stored,
enqueued, staged or sent. No migration, RPC, capability, action, model, provider,
executor, cron or UI file. Contract and the rechecks any later staging step owes:
"Next question proposal" in `docs/architecture/LEAD_QUALIFICATION.md`.

Isolated runner with outbound network denied, Node 24.15.0 (the machine has no
Node 22; earlier entries used 22.23.2): 1,375 unit passes with four existing live
skips (11 new in `eval/lead-qualification-next-question.test.ts`), full lint, offline
production build and post-build typecheck passed; `git diff --check` clean. The
database integration suite was not run: no SQL changed, and tenant and role refusal
of the read is already covered by `eval/integration/lead-qualification.int.test.ts`.
Not viewed in a browser; no screen calls it. Other worktrees and the stale
`platform` checkout were left alone.
[AI: codex] [DATE: 2026-10-12] [AREA: platform] [STATUS: done]
Reviewed Cursor #69 and Claude commit b76ca4d in separate worktrees. Reconciled
both with current main while preserving append-only work-log entries. #69 merged
as 711f00c after both required checks passed; its Node 22 unit run passed 1,368
tests (four live skips). Persisted qualification has existed since #62; Cursor's
old checkout was missing it. A populated qualification review screen remains
unimplemented, and the supplied intake browser fixture was empty. Updated #69's
PR description to correct that dependency and retain the acceptance limitation.

Published Claude's read-only question proposal as #70 on
codex/qualification-next-question, corrected its stale uncommitted status, and
verified 1,374 units on Node 22. Both initial CI checks passed. Reconciled the
branch with merged #69 for a fresh combined CI run before merge. Original agent
checkouts remain untouched. No migration, provider send or deployment performed.

[AI: cursor] [DATE: 2026-10-12] [AREA: platform] [STATUS: review]
Qualification review UI on `codex/cursor-ui-qualification` after merging
`origin/main` so the existing backend is in this checkout. Wired only
`loadLeadQualifications`, `loadLeadQualification`,
`loadLeadQualificationHistory`, and `updateLeadQualification`. Extended
`/intake` (list) and `/intake/[workflowId]#qualification` (review/edit)
with intake chrome. Owners and `crm.read` managers can read; save follows
`can_update` (owner or manager with `leads.qualify`). Staff/revoked get the
same unavailable state as intake.

Unknown fields render as **Unknown** with no source, not yes/no or empty
defaults; known-empty constraints stay distinct. Provenance (source and
intake evidence revision) is shown per field. Stale records use
`needs_review` plus `review_reasons`. `revision_conflict` and other
reload-required outcomes lock saving until a fresh load. Uncertain saves
retry the same command id. `updateLeadQualification` now revalidates
`/intake` and `/intake/[workflowId]` after an accepted save (the contract
said to add that when a screen exists). No new migrations, RPCs, or
nurture/message/consent/identity actions.

Did not copy Claude’s next-question helper — it is not in this checkout
(`proposeNextQualificationQuestion` remains Claude’s lane). Missing fields
come from the record’s `missing` array. Login/onboarding were already
labelled with 44px targets and field errors; no further auth polish.

Local-only preview: applied existing `20261009100000_lead_qualification.sql`
to the disposable 58331 stack and seeded unknown + stale workflows with
`scripts/cursor-preview-qualification-fixture.mjs`. The running 3127
process has a dead file watcher (EMFILE) and kept serving the pre-change
intake compile; screenshots of the new qualification section were not
captured from that process. Targeted tests: 43 passed
(`qualification-review-ui`, `intake-review-ui`, `lead-qualification`,
`login-onboarding-ui`). Lint on touched files passed after removing an
unused helper. `vercel.json` deployment stays disabled. Codex 3109/3110
left alone.

[AI: codex] [DATE: 2026-10-13] [AREA: platform] [STATUS: review]
Reconciled #71 with #70's merged helper, retaining the updated review-first/open-question
contract, then merged #71 after both required checks passed (Node 22 local units:
1,379 passes). Reconciled #72 with current main without touching agent checkouts.
Found and fixed qualification editor state surviving a new server revision and edits
remaining possible after an uncertain save. The editor now remounts on changed server
record context, preserves exact retry payload/command, catches transport failures as
uncertain, and prevents repeat saves after success until refreshed. Four state
regressions added; local units 1,389 passed before #71 integration, lint/offline build
and post-build types passed. Combined CI and browser acceptance follow.
Production read-only audit: correct Supabase project ACTIVE_HEALTHY, 71 applied/93
repository migrations, 22 pending and no production-only versions; all 42 public
tables have RLS. Application release-freeze triggers remain. Hosted scheduled backups
are unavailable on the current Free plan; recoverability is not yet verified.
No production migration, deployment, provider activation or freeze removal performed.

[AI: codex] [DATE: 2026-10-14] [AREA: auth] [STATUS: review]
Private review login was blocked by two mismatched contracts: Supabase allowed only
the production callback, and the callback always returned to the production origin.
Added a deployment-only opt-in using Vercel's server-provided generated hostname,
restricted to this project/team; invalid review configuration fails before code
exchange. Production defaults and redirect/credential filtering remain unchanged.
Full redirect suite now runs against both origins; 97 targeted tests pass. Local Node22: 1,446 unit passes, four live skips; lint, offline build and
post-build types passed. Hosted login verification remains pending. Added exact-host setup
and rollback instructions. This source change does not activate providers/crons,
remove database guards, or promote the public domain.

[AI: codex] [DATE: 2026-10-14] [AREA: qualification-ui] [STATUS: review]
Reviewed Cursor PR73 and merged current main (including private-review callback
fix PR75) into its branch in an isolated checkout. The card calls the existing
pure proposal helper and adds no RPC, send/approval path, or database writes.
It distinguishes questions, review-required reasons and qualification completion;
failed reads render no suggestion. Cursor reports 1,396 unit passes/four skips,
build/types/lint success and fixture contrast/layout checks. Its programmatic focus,
CSS zoom and simulated-width checks are not native keyboard/browser-zoom/mobile
acceptance; can_update=false verifies a read-only manager, not delegated save, and
a failed-load fixture is not a real membership-revocation session. These remain
acceptance follow-ups. Combined verification and merge are recorded separately.

[AI: cursor] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
C1 website-intake setup on cursor/cloud-agent-1792041640122-hbrjc from current
origin/main (baseline merge 3747330; stale pre-baseline local experiments dropped
in favor of origin/main per the handoff baseline rule). New owner-only
WebsiteIntakeCard in Settings (own section + nav, after SMS) reusing the existing
listPublicIntakeForms/configurePublicIntakeForm actions and PUBLIC_FORM_INTAKE
contract; no new RPC, migration, executor, or send path. Shows exact HTTPS origin,
Enabled/Disabled pill and revision per form plus the POST endpoint path; new forms
start disabled and enabling is a separate explicit action. Stale/uncertain saves
refresh the list first with guidance to re-apply against the current revision; no
silent retry. Copy states submissions land in identity review as unverified text
and claims no consent, identity, or readiness. Non-owner reads render an
unavailable notice with no form controls. Local Node22: 1,460 unit passes / 4
skips (122 files, 9 new), lint/tsc/build clean. No live-browser namespace exists
in this environment, so keyboard/mobile acceptance is via native controls,
label-for associations, fluid-layout assertions and existing token contrast —
not a native Tab/zoom/device walk; the full native walk stays in C3. No merge,
deployment, migration, or provider change.

[AI: claude-code] [DATE: 2026-10-14] [AREA: platform] [STATUS: review]
B1: rechecked PR #74 at head `0fd4c9b`. It contains current main, both required
checks pass, and it has no reviewer findings, so no follow-up PR was opened. Migration
94 was re-applied from zero on the disposable `gradia-record-fresh` stack, with
exactly 94 migrations. `verify-lead-qualification-migration.py` passed.
`stage_qualification_question` is security definer with an empty search path,
executable only by `authenticated`. The two qualification integration files passed
33 of 33 in three repeat runs. The first run after the reset had one transient
intake-seed failure.

B3: step 6 quote/booking readiness audit, recorded in
`docs/roadmap/STEP6_QUOTE_BOOKING_AUDIT.md`. Fixed the smallest uncovered
invariant: an accepted quote staged a fixed 120-minute booking whatever the menu
said. `respondToQuote` now sums the shop's current menu durations for the quoted
services, sized to the quote's vehicle, for both the staging availability check and
the booking. When any line has no shop-scoped menu service, it keeps the old 120
minutes, labelled `duration_source: "default"`. The new integration scenarios
failed on unfixed main and pass with the fix. No migration, executor, policy or
conflict-rule change.

Disposable `gradia-record-fresh` stack only, reset from main's 93 migrations, Node
22.23.2 isolated runner:

- `quote-acceptance.int.test.ts`: 17 of 17 on a clean run. Two other runs failed
  only on local-gateway errors: an "invalid response from upstream" while seeding
  a customer, and one run where `beforeAll` hung and tests were skipped.
- Unit: 1,452 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or activated.

[AI: claude-code] [DATE: 2026-10-14] [AREA: platform] [STATUS: done]
Added the step from a reviewed qualification question to a queued message approval,
on `auto/qualification-question-approval` from origin/main `316511d`. The contract
and permission checks were committed first, in `docs/architecture/LEAD_QUALIFICATION.md`.

Migration 94 adds one session-only function, `stage_qualification_question`. Under
the shop and workflow locks it rechecks:

- active owner, before the exact-retry check;
- qualification revision and evidence revision against the proposal basis;
- identity and review state;
- that the target is still the proposed question;
- DNC, STOP and suppression;
- SMS and email readiness;
- that no other question for the lead is waiting.

It then reuses `whisper_command`'s reply staging in the same transaction and tags
the pending row with its qualification binding. Server action
`stageQualificationQuestion` wraps it.

Nothing is sent. Marketing consent, quiet hours, A2P and at-most-once execution
remain the existing executor's checks at approval time. Not built: no screen, no
second executor, no automatic queueing, no change to `whisper_command`, the
executor or consent rules. Leads with no SMS or email thread cannot be queued.

Verified on the disposable `gradia-record-fresh` stack only, reset from this
branch's 94 migrations with the five test fixtures:

- new integration file: 14 of 14;
- unit: 1,395 passed, 4 skipped;
- lint, offline build, types before and after build, `git diff --check`, and
  `verify-lead-qualification-migration.py` (exact 94) all passed.

The full integration suite had 4 failing files out of 40 (3 failed tests,
416 passed). The failures were statement timeouts, seed `createUser` failures,
and auth sign-in timing out after about 18 seconds with `context deadline
exceeded`. Over 10 minutes the gateway logged 119 502 or reset errors, and another
stack's analytics container was crash-looping. Run on their own,
`delegated-message-approval`, `public-form-intake` and `agent-records` passed.
`manager-notification` failed again on its own, each time at sign-in or user
creation. This is recorded as the same unresolved local-environment instability
as October 9, not as a clean pass.

No production or shared database was touched. Nothing was merged or deployed, and
no provider was activated.

### [Codex] 2026-10-14 — PR74 integration review: preserve uncertain delivery holds

Reproduced a replacement question being queued after its predecessor was marked
rejected with an uncompleted send claim. The qualification duplicate guard now
uses the inbox's existing consumed-claim hold definition, including rejected
claims and results recorded without a completed claim. Ordinary rejection before
any send claim still permits a new question. Exact retries remain idempotent.

Added three integration regressions and clarified the contract. A rolled-back
SQL transaction against disposable gradia-record-fresh reproduced the original
bug, then verified all three fixed claim/status cases without persisting schema
or fixture changes. The HTTP regression attempt could not reach the function
because that local stack no longer had migration94; CI must run the complete
suite from migrations. Targeted five unit tests, touched-file lint and diff check
passed. No shared/production migration, deployment, send or provider activation.

[AI: cursor] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
C2 review-and-queue step on cursor/qualification-queue-ui-3f75 from current
origin/main (50e1236, PR74 merged). New QualificationQueueQuestion on
/intake/[workflowId]#qualification behind PR73's suggestion card, staging through
PR74's stageQualificationQuestion action only: editable wording, channel choice
limited to threads that actually exist (read_whisper_thread SMS+email for the
linked customer, owner views only), recipient shown read-only as reviewed, basis
shown, one command id per attempt reused for exact retries. Queued/already_queued
shows an Approvals link and never claims sent/delivered/consent. Mapped
refusal/reload guidance for every code (uncertain retries same id; stale family
locks until reload; command_conflict restarts fresh after re-review; forbidden
hides the control). Managers see an owner-only note with no controls even with
qualify/approve grants; leads with no thread get an honest no-first-message note;
stale/complete suggestions render no queue step. No new RPC, executor, migration,
consent exception, auto-send, or silent retry. Local Node22: full unit 1,470
passed / 4 skipped (13 new), lint/tsc/build/diff-check clean. Same environment
limit as C1: no live-browser namespace here, so native Tab/zoom/device acceptance
stays in C3; revocation/consent-hold paths rest on the existing integration
suite. No merge, deployment, migration, or provider change.

[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
B2: connected lead-workflow acceptance on main `50e1236`, after #74. New file:
`eval/integration/lead-workflow-acceptance.int.test.ts`. It drives one synthetic lead
through the real path, with the SMS provider faked:

1. Inbound SMS intake, including the provider redelivering the event (one workflow).
2. The owner links the identity.
3. The qualification proposal.
4. The `stageQualificationQuestion` server action.
5. Owner or delegated-manager approval through the existing executor.

It covers:

- one send under concurrent and exact retries;
- a hold without consent or a reviewed reply purpose;
- stale evidence;
- a changed recipient, DNC and STOP after queueing;
- manager staging refused, and a deactivated manager unable to approve;
- an unknown provider outcome that never resends and blocks a replacement
  question;
- a website-only lead with no thread that is refused.

Defect found and fixed: `stageQualificationQuestion` refused the proposal's own
`basis` as `invalid` with `field: "basis"`. The proposal includes `workflow_id`,
and the action's schema was strict without it. Every caller following the
published "copy basis unchanged" contract would have failed. #74's tests called
the database function directly and missed it. The schema now accepts `workflow_id`
and requires it to equal `workflowId`. A unit regression fails without the fix.

The unsupported transitions are recorded in `LEAD_QUALIFICATION.md`:

- a queued question is not withdrawn when the record changes;
- there is no "asked" marker;
- an inbound answer does not update the record;
- email was not exercised end to end.

Disposable `gradia-record-fresh` stack only, reset from main's 94 migrations, with
`verify-lead-qualification-migration.py` passing. Node 22.23.2 isolated runner.

- The new suite plus the staging suite passed 23 of 23 in two runs.
- A third run failed seed `createUser` before those tests ran, which is the
  known local auth instability. The first run after the reset also failed seed
  `createUser` and was retried once.
- Unit: 1,459 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or activated.

### [Codex] 2026-10-14 — C1 release review: await configuration reconciliation

Integrated current main while preserving both work-log entries. Replaced the
fire-and-forget route refresh with an awaited session-scoped list action. A
synchronous guard prevents repeat submissions while save/read is outstanding;
a failed read removes mutation controls until page reload. Uncertain creates
retain the original form ID, and a confirmed list containing that ID clears the
add draft. The unavailable message no longer claims nothing changed after a
potentially committed save.

Three state regressions exercise delayed reads, duplicate clicks, failed reads,
and a committed create with a lost response; all pass alongside nine existing
setup tests. Touched-file lint and diff check pass. These are component state
checks, not browser keyboard/mobile/zoom acceptance; Cursor C3 remains outstanding.
No production form was enabled or configured, and no shared migration was applied.

### [Codex] 2026-10-14 — PR78 integration review

Reviewed the staging input fix: an unchanged proposal basis is accepted; a supplied
workflow_id must match the command's workflow. Existing strict fields and database
authorization remain in place. Integrated current main through PR77, preserving
both work-log entries. Eighteen targeted unit tests, touched-file lint and diff
check pass; final combined CI is required before merge. Connected acceptance uses
fake SMS transport and a mocked interaction writer, not live channel or persisted
outbound-history acceptance. Email, send-time qualification freshness, asked-state
tracking and inbound-answer extraction remain documented follow-ups. No migration,
production write, deployment or provider activation was performed in this review.

### [Codex] 2026-10-15 — C2 release review: exact retries and stale-form locks

Integrated main through PR78, retaining website settings and both work logs.
An uncertain staging outcome previously left the message editable despite offering
an exact retry. The submitted command is now frozen; a synchronous guard blocks
concurrent clicks; every failure locks edits. Stale/invalid inputs require a full
reload before a new attempt rather than unlocking ahead of router.refresh.
Held or non-replyable threads are excluded from channel choices. Unusable-thread
copy no longer asserts every read failure means no conversation, and pending-question
guidance includes delivery review rather than assuming approval is always next.

Three behavioral state regressions plus thirteen existing queue UI tests pass;
touched-file lint and diff check pass. Full combined CI remains required before
merge. This is not native browser keyboard/zoom/mobile acceptance or a live send.
No production write, migration, provider activation or deployment performed here.

C2 CI follow-up: two integration attempts failed at disposable Supabase startup,
before tests, with raw output intentionally suppressed. The wrapper was dropping
setup-cli's GHCR registry selection when constructing its clean environment.
Preserved only the allowed ghcr.io value and added fixed-category diagnostics
(no raw CLI output or credentials). Two diagnostics regressions and lint pass.
This is a configuration fix and improved failure visibility, not proof of the
startup failure's root cause; the complete integration run must still pass.
[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
Follow-up from the step 6 audit: the booking confirmation is now staged exactly once
per appointment. Every existing booking suite mocked the drafter to throw, so no
test ever reached confirmation staging.

The new `eval/integration/booking-confirmation.int.test.ts` reproduced the defect on
main `93a9f4a`. When an approved booking's appointment was written but its
confirmation was not staged, the confirmation was lost for good. That happens after
a crash between the write and staging, or after a drafter outage. Both replay
paths, the fast path and the serialized write's `exists` result, returned before
the staging step.

Fix (`src/lib/approvals.ts`, `ensureBookingConfirmation`): on replay, stage the
missing confirmation, but only when:

- no booking confirmation of any status exists for that appointment, which
  includes one the owner rejected;
- the appointment has not started yet.

It is best-effort and never fails the booking. No migration, and no change to the
send path, consent rules or the 48-hour cron.

Disposable `gradia-record-fresh` stack only, 94 migrations. Node 22.23.2 isolated
runner.

- The new suite failed 2 of 6 before the fix.
- Run one file at a time after the fix:
  - `booking-confirmation`: 6 of 6;
  - `booking-atomicity`: 13 of 13;
  - `conflict-enforcement`: 6 of 6;
  - `quote-acceptance`: 17 of 17.
- Two combined runs had failures only in seed helpers: "An invalid response was
  received from the upstream server". The stack's database container had also
  restarted outside this session about 16 minutes before.
- Unit: 1,457 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or activated.

[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
B5 (PR #79 review finding). Reproduced four stale-repair cases in
`booking-confirmation.int.test.ts`. On the previous head, the replay repair:

- confirmed an appointment rescheduled after the failed confirmation for its old
  time;
- confirmed a closed appointment;
- used the customer's old phone;
- left a stale confirmation queued when the appointment moved during the repair,
  shown with a deterministic interleaving before the insert.

Fix (`ensureBookingConfirmation`):

- It drafts from the current appointment (time, length, service, timezone,
  status) and the current customer (name, phone), never from the original
  proposal.
- It refuses a closed or already-started appointment, or a customer with no
  phone. A cancelled appointment is deleted, so there is nothing to confirm.
- After staging it re-reads the appointment. If anything changed, it deletes
  the unsent card it just created, and the next replay drafts a fresh one.
- Rejected confirmations are still respected.
- The guarantee stays scoped to replays serialized by the action claim. There
  is no database uniqueness key per appointment.

Disposable `gradia-record-fresh` stack, 94 migrations. Node 22.23.2 isolated runner,
one file at a time:

- `booking-confirmation`: 10 of 10, after one run that failed seed `createUser`
  before any test.
- `quote-acceptance`: 17. `conflict-enforcement`: 6. `booking-atomicity`: 13.
- Unit: 1,489 passed, 4 skipped.
- Lint, offline build, types after build, and `git diff --check` passed.

Nothing was merged, deployed, migrated on a shared database, or sent.

[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
Follow-up from the step 6 audit: a held quote send approved later, and manager
approval of a quote-bearing message.

The new `eval/integration/held-quote-send.int.test.ts` reproduced the defect on main.
`sendQuote` updated the quote and lead itself, only when its own immediate send
succeeded. When the SMS gate held the send, for example an unverified own number,
a later approval from Approvals sent the quote link but left the quote as `draft`.
The customer's link then refused any response.

Fix: a shared `markQuoteSent` step in `src/lib/approvals.ts`. It runs after any
executed `send_sms` or `send_email` carrying `quote_id`, whoever approved it. It is
shop-scoped, idempotent and best-effort. The lead moves to `quote_sent` only from
`new` or `needs_quote`, never back from `booked`. `sendQuote`'s inline copy was
removed so both paths share it.

Manager finding: a manager with `approvals.messages` can approve a held quote send.
The review hash binds the owner's exact text, and a direct edit changed nothing,
so this is delivery of an owner-priced quote, not price or discount authority.
Whether managers should deliver quotes at all is recorded as an open product
question. The SQL was not changed.

Disposable `gradia-record-fresh` stack only, 94 migrations. Node 22.23.2 isolated
runner, one file at a time:

- `held-quote-send`: 4 of 4. Before the fix, 2 of 3 failed with the quote still
  `draft`.
- `delegated-message-approval`: 26 of 26.
- `whisper-reply-context`: 19 of 19.
- `service-proof-replay`: 15 of 15.
- `quote-acceptance`: 17 of 17.
- Unit: 1,469 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or activated.

[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
B4 (PR #81 review findings). Reproduced with deterministic interleavings. A test
client runs a competing write after the code's read and before its write. Five new
scenarios in `held-quote-send.int.test.ts` failed on the previous PR head:

1. A customer's acceptance during an email quote send was overwritten back to
   `sent`.
2. Racing SMS and email sends lost one channel.
3. A booking during the quote-sent stage move was regressed to `quote_sent`.
4. A racing board move overwrote the winner and its history.
5. A bookkeeping failure left no reconciliation record.

Fix:

- `markQuoteSent` is a compare-and-swap on the status, `sent_via` and `sent_at`
  it read. It retries on a fresh read, up to 5 times. A decided quote keeps its
  status, and SMS plus email become `both`.
- `moveLeadToStage` writes stage, history, timer and legacy `status` in one update.
  The update lands only if the stage and `stage_entered_at` it read are unchanged.
  A new `from` allowlist is checked in the same update, so the quote-sent move
  only advances from new or `needs_quote`. A lost race returns false; the board
  now says to reload instead of blaming a migration.
- A bookkeeping failure never resends. It is logged and recorded on the action as
  `quote_sent_reconciliation`. Replaying the action returns already_decided.
  Recovery is a manual repair of the quote, not a resend.
- An email quote case was added with a fake transport.

Disposable `gradia-record-fresh` stack, 94 migrations. Node 22.23.2 isolated runner,
one file at a time:

- `held-quote-send`: 9 of 9.
- 13 other suites that move leads or send passed, including `quote-acceptance` 17,
  `delegated-message-approval` 26, `control-execution` 16, `agent-records` 19 on
  retry, and `twilio-inbound-replay` 14 on retry.
- `booking-atomicity`: 11 of 13 twice. The two concurrency tests failed in setup,
  in `stagePending`, with "An invalid response was received from the upstream
  server". The local gateway logged 31 such errors in 30 minutes, and this is not
  claimed as a pass.
- Unit: 1,489 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or sent.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
B6: connected qualification acceptance through delivery evidence, built on merged
#78 with no new executor. New file:
`eval/integration/qualification-delivery-acceptance.int.test.ts`. It covers SMS and
email, with the real interaction history (only embeddings disabled) and fake
Twilio and Aurinko:

- one send under concurrent and exact retries;
- exactly one outbound interaction linked to the action and customer, set as
  `result_id`;
- the email threaded to the customer's message;
- `provider_accepted`, never "delivered";
- an unknown outcome held as `claimed`, never resent, with no outbound record
  and a replacement question refused;
- suppression, DNC and SMS STOP after queueing held, with zero external effects
  (no transport, token refresh, ledger entry or interaction).

Added a question transition inventory to `LEAD_QUALIFICATION.md`. Three transitions
are unsupported: a stale question at send, an asked marker, and an inbound answer.
Each is a separate PR; the stale-at-send hold is next.

Disposable `gradia-record-fresh` stack, 94 migrations. Node 22.23.2 isolated runner,
one file at a time:

- New suite: 7 of 7 in two runs.
- `lead-workflow-acceptance`: 6. `qualification-question-staging`: 17.
  `whisper-reply-context`: 19.
- Unit: 1,489 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or sent.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
B6 transition 1: a queued qualification question is now held at send when its
record moved on.

Reproduced first in `eval/integration/qualification-stale-at-send.int.test.ts`. The
previous executor sent a question whose answer had been recorded after queueing.
That happened on SMS, on email, and through delegated manager approval.

Migration 95, `qualification_question_currency`, is one read-only security-definer
function. It applies the staging rules to the action's `qualification` binding:
revision and evidence, identity review, and still the proposed question. Callers
are the owner, a manager with `crm.read`, or the service role.

Both send executors call it first, before the token refresh, consent and proof
checks, transport and ledger. A hold has zero external effects and returns the
action to pending, with a published reason. Messages without a binding are
unaffected, and a check that cannot run fails closed. The contract is in
`LEAD_QUALIFICATION.md` → *Held at send when the record moved on*.
`verify-lead-qualification-migration.py` now also asserts the grants and definer
settings for migrations 94 and 95.

Disposable `gradia-record-fresh` stack, reset from this branch's 95 migrations, with
the verifier passing. Node 22.23.2 isolated runner, one file at a time:

- New suite: 7 of 7. On the old executor it failed 3 of 7.
- Passed: `lead-workflow-acceptance` 6, `whisper-reply-context` 19,
  `delegated-message-approval` 26, `service-proof-replay` 15, `whisper-inbox` 17,
  `lead-qualification` 19.
- `qualification-question-staging`: 17 of 17 on retry, after a seed `createUser`
  failure.
- Unit: 1,489 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Migration 95 is not applied to any shared or production database.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
B7: booking length is decided from the menu at the execution boundary.

Reproduced first in `eval/integration/booking-duration.int.test.ts`. On main, the
executor booked whatever length was staged: a voice model's 30 minutes or a
caller's 600 minutes for a 180-minute menu service. It also booked unmatched,
ambiguous and size-dependent services at the staged length, with no hold.

Fix: `src/lib/booking-duration.ts` → `resolveBookingDuration`, called by
`executeBookAppointment` after the replay check and before the conflict gate.

- **Owner length:** used as given when the owner saved the card in Approvals.
  The editor now sets `duration_source: "owner"`.
- **Quote length:** used as given when quote acceptance computed it server-side
  (#76).
- **Everything else:** exactly one matching menu service sets the length, sized
  to the customer's single known vehicle size when the length varies by size.
- **Holds:** an unmatched or ambiguous service, an unknown size where it matters,
  or an unreadable menu. The owner sees the reason, and nothing is booked.

Voice staging now prefers the menu over the model's duration for its staging
snapshot. Existing booking-atomicity and conflict fixtures now state an
owner-set 2-hour length, which is what their slot arithmetic tests. No
migration, calendar activation or scheduler change.

Disposable `gradia-record-fresh` stack, 95 migrations. Node 22.23.2 isolated runner:

- New suite: 9 of 9 twice. On the old executor it failed 7 of 9.
- `booking-atomicity` 13, `quote-acceptance` 17, `approvals` 4,
  `control-execution` 16, `mcp-capabilities` 11, `agent-records` 19,
  `delegated-message-approval` 26.
- `conflict-enforcement`: 6 of 6 in two of three runs. The failing runs died in
  `stagePending` with PostgREST connection resets, and a branch without this
  change failed the same way on the same stack.
- Unit: 1,494 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

Nothing was merged, deployed, migrated on a shared database, or sent.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
One Twilio subaccount per business. Reproduced with a fake Twilio Accounts API on
the disposable stack.

The previous `ensureSubaccount`:

- created a subaccount for every concurrent purchase and overwrote the stored
  SID, orphaning the others;
- created a second subaccount after a failed save;
- replaced a stored SID with a brand-new subaccount when its token stopped
  decrypting;
- relied on the caller's stale shop snapshot.

Fix:

- It reads the stored SID fresh and never replaces it, recovering the token for
  that SID, which must be named for this shop.
- With no SID stored, it adopts an active subaccount named for the shop and
  refuses when there is more than one.
- It saves only if no SID is stored, and closes a duplicate it created on losing
  that race.
- New Twilio helpers: list by FriendlyName, fetch, and close.
- Migration 96 adds `shops_twilio_subaccount_sid_unique`.
- Contract: `docs/architecture/CHANNEL_PROVIDERS.md`.

Disposable `gradia-record-fresh` stack, reset from this branch's migrations (main's
94 plus 96, applied from zero). Node 22.23.2 isolated runner:

- `twilio-subaccount`: 7 of 7 twice, after one run whose concurrency test failed
  seed `createUser`. On the old code it failed 6 of 7.
- `twilio-status-callback` 12, `twilio-inbound-replay` 14, `tenant-isolation` 8,
  `tenant-relationships` 8.
- Unit: 1,489 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

No real Twilio call, number, migration on a shared database, or activation.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
Resumable SMS (A2P 10DLC) registration with clear rejection and retry handling.
Reproduced against a fake `twilio-a2p` module on the disposable stack. The previous
flow:

- saved SIDs only at the end, so a midway failure orphaned steps and a retry
  rebuilt the whole chain;
- allowed resubmission while carriers were reviewing or after approval;
- recreated the messaging service when a campaign failed;
- kept only a free-text reason.

Fix:

- Each step's SID is checkpointed as soon as it exists, and a resubmission with
  the same details resumes.
- Resubmission is refused while with carriers or approved.
- A rejected brand or changed details start a fresh chain. A rejected campaign
  keeps the approved brand and messaging service.
- The messaging service is created once, and an "already attached" number
  counts as done.
- Sync reports a stage as advanced only once it is saved.
- Migration 97 adds `failed_step`, `retryable`, `attempts` and
  `last_attempt_at`.
- `describeA2pRegistration` gives the UI one `nextAction`, exposed via
  `getA2pState` and `refreshA2pStatus`.
- Contract: `CHANNEL_PROVIDERS.md`.

Disposable `gradia-record-fresh` stack, reset from this branch's migrations (main's
94 plus 97, applied from zero). Node 22.23.2 isolated runner:

- `a2p-registration`: 7 of 7 twice. On the old code it failed 7 of 7.
- `twilio-status-callback`: 12 of 12 on retry, after a seed gateway error.
- `tenant-isolation`: 8.
- Unit: 1,492 passed, 4 skipped.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

No real Twilio registration, migration on a shared database, or activation.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
Owner attestation for own-number (BYO) texting. Contract:
`docs/architecture/BYO_SMS_ATTESTATION.md`. Migration `20261015150000` (95 on
main; PRs #83, #87 and #88 hold 95–97, so the number will move at merge).

`shops.byo_sms_verified` gates every text from a non-Gradia number
(`smsGateForShop`, plus the `stage_qualification_question` mirror). Nothing wrote
it, so every own-number text was held.

New pieces:

- Owner-only `attest_byo_sms_registration`, `revoke_byo_sms_registration` and
  `read_byo_sms_attestation`. The caller must be `shops.owner_id` with an active
  owner membership; managers and staff are refused whatever their capabilities.
- Attesting needs `confirm: true`, the current statement version, and the exact
  number the owner was shown. It refuses `number_changed`, `no_number` and
  `gradia_number`.
- An append-only `byo_sms_attestations` history records event, number, actor,
  statement version and time.
- A guard trigger stops a signed-in session setting the flag directly on shops,
  on update or insert. A second trigger clears the attestation whenever
  `twilio_phone_number` changes, through any writer.
- Session-client server actions `getByoSmsAttestation`,
  `attestByoSmsRegistration` and `revokeByoSmsRegistration`.

The Gradia-number gate is unchanged, and a unit test pins that the flag never
opens it. A provider-verifiable check was considered and deferred: it needs live
calls and covers only some numbers. The `source` column leaves room for it.
UI is Cursor's.

Disposable `gradia-record-fresh` stack, reset from this branch's 95 migrations,
Node 22.23.2 isolated runner:

- `byo-sms-attestation`: 6 of 6 in three of four runs. The other run failed
  seed `createUser` before any test ran.
- After a reset, 68 tests passed: this suite plus `qualification-question-staging`
  (17), `lead-workflow-acceptance` (6), `team-permissions` (27) and
  `tenant-isolation` (8). Those suites set the flag through the service role,
  which still works. `approvals` was the one failure in that run.
- The full suite failed 24 tests, then 17 on retry, all with gateway 502s,
  statement timeouts or seed failures. A reset to origin/main on the same stack
  showed the same thing: the same 10 tests fail in `manager-notification`,
  `whisper-inbox`, `lead-qualification` and `customer-merge`. `approvals` passes
  on the first run after a reset and fails 3 of 4 on the second, on main and on
  this branch alike. These are pre-existing local-stack failures, not regressions.
- Unit: 1,498 passed, 4 skipped, 9 of them new.
- Lint, types before and after the offline build, and the build itself passed.

No merge, deployment, shared migration, provider call or send.

[AI: claude-code] [DATE: 2026-10-16] [AREA: platform] [STATUS: review]
Reworked BYO SMS attestation (PR #93) against
`ONBOARDING_AND_BUSINESS_UX_HANDOFF.md`, which the first pass hadn't read. Gap
found: a non-Gradia number on a shop with no Twilio credentials of its own sends
through Gradia's pilot `env` account (`resolveTwilioCredentials`). The first pass
let the owner attest it, which would put texts on Gradia's account under a
registration the owner can't hold.

Changes:

- Attesting now needs the shop's own encrypted credentials. Otherwise the state
  is `not_own_account`, attesting is refused, and texts stay held.
- A credential change or removal clears the attestation (`account_changed`).
  Rotating only the token doesn't.
- The statement names the owner's own account and Messaging Service. Its version
  is now `2026-10-16`.
- `byoSmsSetupStatus` maps states onto the handoff vocabulary. Confirmed is
  "Ready to test", never "Ready".
- The deferred provider check is now cited against current Twilio docs
  (UsAppToPerson `campaign_status`).

Recorded conflict: PR #89 maps the flag to texting `ready`. It should cap at
"Ready to test" and report `not_own_account`.

Disposable `gradia-record-fresh` stack, reset from 95 migrations:

- Attestation suite: 8 of 8, twice.
- Focused run: 66 of 66 across `qualification-question-staging`,
  `lead-workflow-acceptance`, `team-permissions` and `tenant-isolation`.
- Unit: 1,499 passed, 4 skipped.
- Lint, types before and after the build, and the offline build passed.

The full-suite local failures recorded above are unchanged and also occur on
main.

No merge, deployment, shared migration, provider call or send.


[AI: claude-code] [DATE: 2026-10-15] [AREA: platform] [STATUS: review]
Separate, accurate readiness for calls, texting, email and Meta. Contract:
`docs/architecture/CHANNEL_READINESS.md`.

The single `connectionStatus().connected` flag overstated readiness:

- texting showed connected with A2P pending, rejected or unregistered, or with an
  unconfirmed own number;
- calls showed connected with only an assistant;
- email showed connected with no inbound subscription;
- Meta had no state at all.

New pieces:

- `channelReadiness` (pure). Each channel returns one state (`unavailable`,
  `not_set_up`, `in_progress`, `action_needed`, `limited` or `ready`), with
  reason codes and an owner message, from the evidence that gates it.
- `loadChannelReadiness`, which uses the service client, scoped by shop, because
  Meta bindings are service-role only. A failed read is an error, never "not set
  up".
- The owner action `getChannelReadiness()`, now on the reviewed service-role
  importer list.

`connectionStatus()` and the screens are unchanged; switching the UI is Cursor's.
Gaps are recorded: no in-app BYO attestation writer, a revoked mailbox grant isn't
detected without a provider call, and Meta's subscription is unverified.

Disposable `gradia-record-fresh` stack:

- `channel-readiness`: 4 of 4 twice.
- Unit: 1,504 passed, 4 skipped, including the table of old-flag overstatements
  and `connection-truth`.
- Lint, offline build, types before and after build, and `git diff --check`
  passed.

No migration, provider call, or activation.

[AI: claude-code] [DATE: 2026-10-16] [AREA: platform] [STATUS: review]
PR #89 (`claude/channel-readiness`): texting readiness for an own (BYO) number
now follows the onboarding handoff and the BYO attestation contract in PR #93
(`docs/architecture/BYO_SMS_ATTESTATION.md`). A checked setting alone is never
`ready`.

- New state `ready_to_test`. An own number with the shop's own encrypted
  Twilio credentials and `byo_sms_verified` reports `ready_to_test`
  (`byo_owner_attested`), matching `byoSmsSetupStatus("confirmed")`.
- New reason `not_own_account`. A non-Gradia number without both
  `twilio_account_sid_enc` and `twilio_auth_token_enc` is `action_needed`
  whatever the flag says, because its send would fall back to Gradia's pilot
  env account. It's checked before the flag.
- `readinessStatusLabel()` maps each state to the handoff vocabulary. The
  mapping is documented in `CHANNEL_READINESS.md`, whose known gaps now point
  to #93 as the writer and name the credential-presence and A2P-alone limits.
- Unit tests check every combination of flag, credentials and A2P state for an
  own number: none is `ready` or "Ready". The integration test adds the
  own-number sequence from real rows.

Checks, Node 22.23.2 isolated runner:

- Unit: 1,546 passed, 4 skipped (`channel-readiness`: 57).
- Lint, types before and after the offline build, the offline build, and
  `git diff --check` all passed.
- `channel-readiness` integration on `gradia-record-fresh`: 5 of 5 on the first
  run. The second run hit a gateway "invalid response from upstream" on a
  `shops` update (4 of 5), and its one retry failed in seed `createUser`
  (suite skipped). Both are stack flakes, with no assertion failures; not
  retried further.

Merge-order note: #93's unit test that lists `src/` files mentioning
`byo_sms_verified` will need `src/lib/channel-readiness.ts` and
`src/lib/data/channel-readiness.ts` added as readers, whichever PR merges
second. No migration, provider call, send, merge or deploy.

[AI: cursor] [DATE: 2026-10-18] [AREA: platform] [STATUS: done]
Separated onboarding from the duplicate Super Agent research on PR #91.
Research stays on #85/#86 with migration `20261016040000`. Removed #91's
`20261016053000` research migration so it no longer shares a version with #90's
browser check. Wired setup and Settings to #88 `nextAction`, #89 channel
readiness, and #93 owner attestation. Calls and texting have separate statuses.
An owner-confirmed own number is Ready to test. Skipping the number still
advances. Did not merge, deploy, apply a shared migration, or add a browser
provider. Authenticated saves were not run here: this environment has no
disposable Supabase.

### [Codex] 2026-10-19 — Combined onboarding and telephony integration

Core workflow PRs #79/#81/#82/#83/#84 passed combined Node 22 checks and database
integration and merged as #94. This follow-up integrates #87/#88/#89/#93 and
Cursor's reconciled #91 without the experimental employee schema or routes.

Kept independent channel setup evidence, A2P saved checkpoint/next-action controls,
and owner-only own-number confirmation. Failed/uncertain reads do not invent a
successful registration or an unsaved attestation. Duplicate confirmations are
blocked synchronously, number changes require a fresh confirmation, and progress
saves compare the settings they read before writing to preserve concurrent edits.
Onboarding resolves the active owned business rather than the oldest business.

Unreadable configured Twilio credentials now fail closed, including explicit-null
transport and signature calls; they cannot silently use the shared pilot account.
The new audit table inherits an existing release freeze. No provider was called,
no message sent and no public release or write unfreeze performed.

Local Node 22 unit run: 1,582 passed, 4 skipped; three additional attestation state
regressions pass. Typecheck passes after the integration-test type fix. Full final
CI/build/integration and migration upgrade validation remain required before merge.
Browser acceptance from Cursor's fixtures is not authenticated acceptance.

Integration build caught a client/server import boundary: readiness labels imported
the provider module, pulling node:crypto into onboarding. Moved the unchanged
voice prerequisites into a pure shared module and kept the provider re-export.
The new audit table upgrade is verified with RLS and 63/63 ALWAYS write guards.
[AI: cursor] [DATE: 2026-10-19] [AREA: platform] [STATUS: done]
Signed-in onboarding acceptance against the disposable Supabase stack
(`gradia-isolated-tests` only). `next dev` must list `127.0.0.1` in
`allowedDevOrigins` or the login page never hydrates at the stack's site URL
and the magic-link form does a full reload. After that, an owner session
saved North Shore Auto, reloaded on Your number, skipped the number, and
reloaded on Choose your help. Calls and texting stayed separate rows. With
no telephony provider configured they both read Unavailable, not Ready.
A rejected campaign row seeded only in that disposable database opened Needs
a correction with the saved legal name. Resubmit did not claim "Submitted
for texting review"; the server refused because the number is not on a
Gradia phone account. No Twilio call, no shared migration, no merge, no
deploy. At 390px and at 200% zoom the wizard did not overflow horizontally.
Tab reached See phone help, Back, and Finish setup. The Next.js dev overlay
is also in that tab order while `next dev` is running.

[AI: cursor] [DATE: 2026-10-20] [AREA: platform] [STATUS: done]
Local magic-link callbacks were leaving the loopback site for the production
origin because `trustedOrigin()` ignored `GRADIA_DASHBOARD_URL` whenever
private review was off. The disposable GoTrue site URL was already
`http://127.0.0.1:3000`, so this was application code, not the provider allow
list. Off Vercel, only a loopback dashboard URL may replace production.
Request headers and any non-loopback dashboard URL still cannot. Commit
`6cbcc50909add7bde451ffab8fdef1f517b3de45` on
`cursor/auth-onboarding-acceptance-4757`, based on merged PR #95. Channel
readiness panel and BYO uncertainty handling were not edited. Authenticated
`next start` acceptance on the disposable stack covered owner save, resume,
skip, reload, rejection retry without a submission claim, independent
Unavailable channel rows, owner confirm and withdraw, failed channel and
own-number reads, a manager, and a revoked membership. Keyboard Tab, 390px,
320px, and Chrome 200% zoom were run on that signed-in build. No provider
call, shared migration, merge, or deploy.
[AI: claude-code] [DATE: 2026-10-19] [AREA: platform] [STATUS: review]
A2P registration slice 1: single-flight and no duplicate campaigns. Fixes
findings R1, R2, R3 and R5 of the October 19 Twilio review
(`docs/release/TWILIO_REVIEW_AND_PROVIDER_CHECKLIST.md`). Built on PR #95
(`6644e53`). The review's probes reproduced each finding on the old code.

- R1, R2: submit and status check take the registration's claim with a
  compare-and-swap lease (`a2p_claim_registration`, 15 minutes) before any
  provider call. A caller that can't take it calls nothing. Checkpoints are
  written only while the claim is held. `a2p_finish_registration` releases it
  and writes the registration status and `shops.a2p_status` in one transaction.
- R3: before creating a campaign, the messaging service's existing Usa2p
  campaigns are listed, and one found there is adopted.
- R5: a campaign-only rejection keeps the failed campaign and edits it in place
  (Usa2p update, all seven required fields; Twilio errors 30899, 30901, 30909).
  A refused edit is recorded; no second campaign is created.
- Migration `20261019120000_a2p_registration_claim.sql`: two columns and two
  functions executable by `service_role` only. Additive.
- Regression tests: `a2p-registration-recovery.int.test.ts` (the probes, now
  asserting the fix) and `twilio-a2p-campaign.test.ts` (wire contract with fetch
  faked). The existing suite's campaign-resubmission test now expects the edit.

Disposable `gradia-record-fresh` stack, reset from this branch's migrations.
Node 22.23.2 isolated runner:

- `a2p-registration-recovery` and `a2p-registration`: 14 of 14, first run.
- Unit: 1,588 passed, 4 skipped. Lint, types and offline build passed.
- Full `integration --fresh`: not completed. The stack stopped answering
  partway (ECONNREFUSED, seed `createUser` failures) and the Docker daemon
  stopped. Every failure was a connection or seed error, none an assertion.
  Rerun once Docker is back.

Limits: campaign edit via API is a Twilio beta; brand and campaign progress is
still pulled only by status checks (R6); `MessageSamples` is sent as a JSON
string in one form field, as before, to confirm on the first live run. No
Twilio call, shared migration, merge or activation.

[AI: claude-code] [DATE: 2026-10-19] [AREA: platform] [STATUS: review]
A2P registration slice 2: approved campaigns stay watched. Fixes findings R4
and R7 of the October 19 Twilio review, stacked on slice 1.

- R4: status checks keep re-reading `approved` and `suspended` registrations.
  `campaign_status` is mapped explicitly. VERIFIED opens texting; SUSPENDED sets
  `suspended`, FAILED `rejected`, and IN_PROGRESS, PENDING or anything unknown
  `campaign_pending`. All of these close the gate. A suspended registration
  can't be resubmitted; it reopens only when VERIFIED again.
- R7: every status change writes the registration and `shops.a2p_status`
  together (`a2p_finish_registration`). A verified check rewrites the gate,
  repairing a shop left `pending` by the old two-statement write.
- Migration `20261019140000_a2p_campaign_suspended.sql` widens both status
  checks. Gate reason, readiness reason `registration_suspended`, onboarding
  copy and the wizard say texting is paused and to contact support. Shown as
  "Needs a correction", because the handoff vocabulary has no suspended label;
  that wording is the release lane's call.
- No scheduler or cron. A suspension is noticed on the next webhook or check
  (R6).

Disposable `gradia-record-fresh` stack, reset from this branch (main's 98
migrations plus 20261019120000 and 20261019140000). Node 22.23.2 isolated runner:

- `a2p-registration-recovery` and `a2p-registration`: 19 of 19, first run.
- Full `integration --fresh`: 521 passed, 14 failed. The 14 failures are the
  baseline the number-ownership session measured on main's schema on the same
  stack (manager-notification 6, whisper-inbox 2, intake-identity 2,
  intake-vehicle 2, lead-qualification 1, customer-merge 1). Every Twilio and
  A2P file passed. This run covers slice 1's code too.
- Unit: 1,591 passed, 4 skipped. Lint, types and offline build passed.

No Twilio call, shared migration, merge or activation.
[AI: claude-code] [DATE: 2026-10-19] [AREA: platform] [STATUS: done]
Twilio review slice 3, number ownership and purchase (findings I1 and R8 in
`docs/release/TWILIO_REVIEW_AND_PROVIDER_CHECKLIST.md`), on
`claude/twilio-number-ownership` from main after #95. Gradia's master
(env) account now serves a business only when `TWILIO_PILOT_SHOP_NUMBERS`
lists that shop and number. #95's explicit-null refusals are kept; only the
`{}` fallback is narrowed. Migration `20261019130000` makes
`shops.twilio_phone_number` server-written (guard trigger like #93's). The
owner number form saves only the shop's Gradia number, its listed pilot
number, or a number on its own Twilio account, checked with those
credentials. `purchaseNumber` re-reads the stored number, adopts a number
already on the subaccount, writes only if none is stored, and meters once.
Added a cross-business inbound-isolation integration suite and a read-only
preflight, `scripts/preflight-twilio-number-ownership.sql`. No provider
calls, sends, shared migrations, activation, merge or deploy.
Unit 135 files, lint, types and build pass. integration --fresh on the disposable stack: 527 passed, 14 failed. Those 14 also fail on main's schema in 6 non-Twilio files; every Twilio suite passes.
[AI: claude-code] [DATE: 2026-10-19] [AREA: platform] [STATUS: done]
Twilio review slice 4, delivery status (finding I5), on
`claude/twilio-delivery-status` from main after #95. The status callback
now only moves `twilio_status` forward (queued < sent <
delivered/undelivered/failed), with a compare-and-swap on the status it
read. When terminal outcomes conflict (delivered vs undelivered/failed, in
either order), the first one stored is kept. The later one goes to
`metadata.twilio_status_conflict` for review, as documented in the route
and in `CHANNEL_PROVIDERS.md`. Review probe R5 is now a regression test. No
migration, provider calls, sends, merge or deploy. Existing rows are not
backfilled.
Unit 135 files, lint, types and build pass. integration --fresh on the disposable stack: 512 passed, 14 failed. Those 14 are the main-schema baseline in 6 non-Twilio files; every Twilio suite passes.

[AI: codex] [DATE: 2026-10-20] [AREA: platform] [STATUS: review]
Combined #96/#97/#98/#99/#100 in an isolated branch; preserved both appended work
logs and all conflicting tests. Reviewed trusted auth origin, registration leases,
atomic status checkpoints, number adoption/isolation and delivery conflicts.
See docs/release/OCT20_TELEPHONY_INTEGRATION.md for Cursor acceptance evidence,
remaining activation blockers and three-migration upgrade gate. No experimental
employee work included. Final combined CI is required before merge/deployment;
no provider activation, live calls or write unfreeze is authorized by this review.

[AI: claude-code] [DATE: 2026-10-20] [AREA: platform] [STATUS: done]
Number-lifecycle audit of uncertain provider outcomes on
`claude/twilio-number-release`, on main after #102 (which merged #98). Ran 16 scenarios against the
disposable database with a fake Twilio. On #98's head, 5 proved gaps:
- a second purchase while the first was still provisioning bought a second,
  billed number;
- a stray duplicate stayed on the subaccount after a release;
- the BYO provision path released the number after a failed save, which
  strands it or destroys a save that committed;
- BYO overwrote an already stored number.

Fixed:
- Migration `20261020120000` adds a per-business purchase claim (two
  nullable columns; existing rows unchanged).
- `purchaseNumber` and BYO provisioning take that claim before any provider
  call.
- Release frees every number on the business's subaccount.
- BYO provisioning adopts a number already on the owner's account, writes
  only if none is stored, and never releases after a failed save.

Lost or refused releases, release then re-buy, a disconnect mid-send, and
#95's explicit-null refusals with the pilot allowlist already held. They now
have tests. No provider calls, sends, shared migrations, merge or deploy.

[AI: claude-code] [DATE: 2026-10-20] [AREA: platform] [STATUS: review]
A2P evidence freshness, held reconciler and uncertain-outcome audit. These are
three stacked PRs on main `6d4c235`. Merge them in order: evidence, then
reconciler, then outcomes. Backend only; no Cursor UI files were touched.

- **Evidence** (`77f2eea`, migration `20261020100000`):
  - The send gate opens a Gradia number only when it is `approved` AND a VERIFIED
    campaign read is younger than `A2P_EVIDENCE_MAX_AGE_HOURS` (default 72,
    ceiling 168; missing means stale). A failed check never renews it.
  - Check outcomes are recorded apart from carrier states.
  - A guard stops owners setting `a2p_status = 'approved'` or forging evidence.
    The shops row policy allowed it before.
  - No backfill: approved shops are held until their first successful check
    (`scripts/preflight-a2p-evidence.sql`).
- **Reconciler** (`a730cae`, migration `20261020110000`):
  - `GET /api/internal/a2p-reconcile` is cron-secret guarded and off unless
    `A2P_RECONCILER_ENABLED=true`. It isn't in `vercel.json`.
  - It is bounded and takes each due row with a compare-and-swap, then the
    registration's claim and that shop's own subaccount.
  - Backoff runs from 5 minutes to a cap, and every interval is at most a
    quarter of the evidence age.
- **Outcomes** (`83a5ed8`):
  - The probes (`dfd7228`) reproduced a second brand and a second messaging
    service after a lost create response.
  - Both are now adopted from the subaccount's own lists.
  - Provider calls time out after 30 seconds, well inside the 15-minute lease.
  - The R9 partial TrustHub bundle is still rebuilt on retry. It's unbilled;
    that's a follow-up.

Disposable `gradia-record-fresh` stack, reset from each branch. Node 22.23.2
isolated runner:

- A2P suites: 36/36 on evidence, 43/43 on reconciler, 48/48 on outcomes.
- Full `integration --fresh` on outcomes: 563 passed, 14 failed. Main `6d4c235`:
  542 passed, the same 14 failed. Those are 6 non-Twilio files.
- Unit: 1,622, 1,627 and 1,630 passed. Lint, types and offline build passed on
  each.

No provider calls, purchases, sends, shared migrations, merge or activation.

[AI: claude-code] [DATE: 2026-10-21] [AREA: platform] [STATUS: review]
Diagnosed the "14 baseline" local integration failures, in the same six files
every run (manager-notification 6, whisper-inbox 2, intake-identity 2,
intake-vehicle 2, lead-qualification 1, customer-merge 1). They weren't defects.

CI's `scripts/test-stack.mjs` applies five test-only SQL fixtures from
`tests/sql/` after every reset: injected failures and a notification clock. The
local `gradia-record-fresh` procedure (`supabase db reset` directly) never
applied them. Missing helpers surfaced as `PGRST202`, for example
`test_notification_clock`.

Fix:

- The fixture list is now shared (`scripts/test-fixtures.mjs`), so CI's script
  and local resets can't drift. CI behavior is unchanged.
- A new `scripts/record-fresh-reset.mjs` resets the unlinked record-fresh stack
  and applies the fixtures.
- `eval/test-fixtures.test.ts` fails if a `tests/sql` file is left off the list.

Result: main `6d4c235` with fixtures, full integration `--fresh`: 53 of 53
files, 556 passed, 1 todo, 0 failed. Unit: 1,612 passed, 4 skipped. Lint passed.
Earlier entries citing "14 baseline failures" should be read as this missing
setup. No migration, provider call or shared database change.
[AI: claude-code] [DATE: 2026-10-21] [AREA: platform] [STATUS: done]
SMS status callbacks that arrive before the outbound interaction is saved, on
`claude/sms-callback-evidence` from main `6d4c235`. Previously the callback
was acknowledged and dropped, which was reproduced on main: 5 of 9 new tests
fail there.

- Migration `20261021100000` stores verified callbacks as shop-scoped
  evidence keyed by MessageSid.
- A trigger on `interactions` applies that evidence when any send path writes
  the row, using #99's rules mirrored in SQL. Both sides take one advisory
  lock.
- The route returns 5xx when storing fails.

Full integration with the test fixtures: 565 passed, 0 failed. No provider
calls, sends, shared DB, merge or deploy.
[AI: claude-code] [DATE: 2026-10-21] [AREA: platform] [STATUS: done]
Operator-visible terminal delivery conflicts on the existing delivery-review
authority, on `claude/sms-delivery-conflict-review` from main `6d4c235`.

- Migration `20261021110000` adds `list_delivery_conflicts`,
  `read_delivery_conflict` and an append-only, audited
  `record_delivery_conflict_resolution`. A conflicted message reads as
  `conflicting`, never `delivered`.
- The backend contract for Cursor is in
  `docs/architecture/DELIVERY_CONFLICT_REVIEW.md`, with `smsDeliveryState()`
  for other readers.
- No UI files changed. The interaction timeline still needs to adopt the
  helper.

Full integration with the test fixtures: 565 passed, 0 failed. No sends,
shared DB, merge or deploy.

[AI: claude-code] [DATE: 2026-10-21] [AREA: platform] [STATUS: review]
PR3, delivery lifecycle acceptance:
`eval/integration/delivery-lifecycle-acceptance.int.test.ts`. One business's
message runs end to end on the real disposable database:

1. intake;
2. qualification;
3. an owner-queued question with reply purpose;
4. manager or owner approval, sending exactly once;
5. a signed terminal callback arriving **before** the interaction is saved (kept
   and applied, #113);
6. a failed delivery, never resent;
7. cross-business signer misuse refused;
8. an uncertain send held across owner, manager and service retries, with no
   replacement queued;
9. contradictory delivered and undelivered results shown as `conflicting` on the
   delivery-review surface and resolved by the manager, with the revoked member
   refused (#114);
10. a STOP through the signed inbound route holding a queued send with zero
    transport.

Real: interactions, the SMS gate, the status and inbound routes, consent
keywords, approvals and delegated review. Faked: Twilio transport, the
classifier and drafter, and embeddings. No poller, reconciler or provider is
activated.

One wrong expectation was fixed in the test, not the product: after an
executed approval, a manager approval correctly returns `already_decided` and
sends nothing.

Cursor handoff: `docs/architecture/CURSOR_DELIVERY_STATUS_HANDOFF.md`. It
covers the actual delivery, review, conflict and readiness states with their
conditions, and flags `interaction-timeline.tsx` showing Delivered for a
conflicted text.

Depends on #112 (fixtures), #113 and #114.

Results:

- Lifecycle suite: 5 of 5, twice.
- Full integration `--fresh` with fixtures: 56 of 56 files, 579 passed,
  1 todo, 0 failed.
- Unit: 1,619 passed, 4 skipped.
- Lint, offline build, and types after the build passed.

No migration of its own, provider call, shared database change or send.

[AI: codex] [DATE: 2026-10-21] [AREA: operations] [STATUS: foundation]
Recorded the approved operations OS roadmap, lane ownership, release boundaries and
exact continuation steps in docs/roadmap/AGENTIC_OS_EXECUTION_PLAN.md. Added a pure,
unused pending-action queue projection: mixed-shop input fails closed; missing claim
evidence and terminal delivery conflicts remain unresolved; counts describe only the
loaded window; no payloads or execution paths. Not yet connected to an authorized
loader or UI. No migration/provider/shared-state changes. Isolated Node 22: 1,622 unit
passed, 4 skipped; full lint, types, offline build passed. Database integration is
still required when the authorized loader is added, and for the separate release batch.

[AI: codex] [DATE: 2026-10-21] [AREA: platform] [STATUS: done]
Finished the authorized pending-action operations loader on
`codex/operations-foundation` / draft PR #111. Migration `20261021120000` adds a
bounded read RPC over existing pending actions, sending claims and conflict evidence;
it returns no payloads or proof claims. Live membership is checked on every page.
Owners receive their shop only; managers are filtered by the existing
`approvals.messages` and `delivery.reconcile` grants; staff, revoked, foreign,
anonymous and sessionless service callers fail closed. The server-only owner loader
derives its shop from the authenticated request, and strict response validation makes
failed or inconsistent evidence unavailable rather than empty. No page uses it yet.
Disposable reset: 102 migrations through `20261021120000`; new integration 5/5.
Node 22.22.0: 1,626 unit passed / 4 skipped, lint/types/offline build passed. Full
integration reached 560 passed / 1 gateway-seed failure / 1 todo; the unrelated
booking file passed 13/13 on immediate rerun. No shared migration, UI, executor,
provider/cron activation, send, deploy, write unfreeze or public promotion.

[AI: codex] [DATE: 2026-10-22] [AREA: platform] [STATUS: done]
Extended draft PR #111's authorized operations read model across unresolved intake
without adding a task store or executor. The mixed-source cursor is stable, completed
sends cannot starve a page, linked workflow/action evidence groups as one work item,
and source provenance points only to existing permission-checking routes. Added a
server-observed deterministic brief contract with explicit unavailable and partial
coverage states, plus a manager loader that validates the requested workspace against
the signed-in `team_workspaces` result before the RPC rechecks live grants. Disposable
reset applied 103 migrations; the expanded real-session suite passed 8/8. Node
22.23.4: 1,630 unit passed / 4 skipped; lint, types and offline build passed. Full
integration reached 562 passed / 1 gateway-seed failure / 1 todo; the complete
unrelated callback file passed 16/16 on immediate rerun. No UI, source mutation,
shared database, provider/cron activity, send, deploy, write unfreeze or promotion.

[AI: cursor] [DATE: 2026-10-20] [AREA: platform] [STATUS: in-progress]
Onboarding copy and skippable welcome transition on
`cursor/onboarding-welcome-copy-fdbe`. Help step asks “What would you like
help with first?” Finish setup opens `/dashboard?welcome=1` with
“Welcome to Gradia, [business name].” Continue is immediate — no timer,
progress bar, or “everything is connected.” Particles respect reduced
motion. Handoff recorded in `docs/handoffs/CURSOR_UI_COPY_AND_MOTION_2026-10-20.md`.
Did not change dashboard review copy, inbox empty states, public pages,
actions, or send behavior. No merge or deploy.

[AI: cursor] [DATE: 2026-10-22] [AREA: platform] [STATUS: in-progress]
Rebased #101 onto current main (`6d4c235` / #102) and kept both appended
work logs. Retargeted the 2026-10-09 design-token lock so the wizard
still says “Step N of 3” and phone help still names +$29/month, now
through `STRINGS.pages.onboarding`. Added source locks for skip,
Escape, reduced motion, mobile chrome, and onboarding error recovery —
fixture checks, not signed-in browser acceptance. No disposable
Supabase in this environment. No merge, deploy, permission change, or
provider activation.

[AI: cursor] [DATE: 2026-10-22] [AREA: platform] [STATUS: in-progress]
Rebased #103, #104, #105 and #106 onto current main and kept both
appended work logs. Local copy tests passed on each rebased branch.
Signed-in onboarding/welcome browser acceptance is still blocked here:
no Docker, no Supabase CLI, no `.env.local`, and no disposable
`gradia-isolated-tests` stack. Skip, Escape, reduced motion, mobile
chrome, and error recovery are locked as source/fixture checks on #101,
not as Chrome sessions.

[AI: cursor] [DATE: 2026-10-22] [AREA: marketing] [STATUS: blocked]
Audited `trygradia-max/Gradia-Web-Cursor` `site-v2` against the October
20 copy brief. Prepared `cursor/marketing-copy-audit-fdbe` locally
(commit `581ce59`): drop $20 / founding / July launch, replace trial
CTAs with Request pilot access, stop claiming live channels and
payments. Push and PR were refused — `cursor[bot]` has no write access
to that repo. Patch saved at
`/opt/cursor/artifacts/marketing-copy-audit-fdbe.patch`. Did not merge,
deploy, change backend permissions, or activate providers.
