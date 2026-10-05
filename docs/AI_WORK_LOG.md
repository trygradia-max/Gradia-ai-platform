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

[AI: cursor] [DATE: 2026-10-05] [AREA: platform] [STATUS: done]
Polished the existing Whisper list, thread, loading state, and controls on
`codex/cursor-whisper-ui-polish` for phone, tablet, and desktop reading, keyboard
focus, labels, and error or status text. Permissions, command IDs, revisions, and
approval staging were left in place. Node 22 isolated unit result: 1,169 passed
and 4 skipped; lint, offline build, and post-build types passed. A fictional
static fixture was checked at 320, 390, 768, and 1280. Authenticated browser
sessions were not run. See docs/qa/WHISPER_UI_ACCEPTANCE.md. Local commit only;
no push, merge, deployment, shared database, or provider activity.
