# Gradia Memory

> Planning baseline: `main` at `20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5`, plus
> verified draft [PR #44](https://github.com/trygradia-max/Gradia-ai-platform/pull/44)
> at `3b99bf4b5d9022a248bd1716fe2b070d8ae455f5`. PR #44 is **pending, not merged**.
> This documentation branch starts at that reviewed head to describe its safety
> boundaries accurately; inherited changes are not new documentation-phase implementation.
> Source review: 2026-09-10 (local). Static inspection and prior verification are
> distinguished from live acceptance. No production access or live model evaluation.
> The founder's current architecture request governs this proposal where older
> scope documents conflict. Neither the original nor committed `CONTEXT.md` is edited.

## MVP NOW

Gradia Memory is structured, scoped operational knowledge with evidence and human
control. It is not an ever-growing prompt, raw transcript archive or a separate
vendor-hosted “brain.” Gradia owns the records; models extract candidates and consume
approved context. Database facts and permissions outrank model prose and vector hits.

| Memory class | Authority and use |
| --- | --- |
| Operational facts | CRM, vehicles, quotes, appointments, current consent and menu are authoritative structured records; retrieve current values, do not duplicate price/consent truth into vectors |
| Conversation evidence | `interactions`, call transcripts and source event references retain what was actually said; speaker and timestamp matter |
| Customer/vehicle preferences | Scoped fact with provenance, destination/vehicle where relevant, validity, confidence and review state; distinguish stated preference from inferred habit |
| Shop rules and preferences | Authorized shop-approved service guidance, tone and operating constraints with versions; rules cannot override code safety, role permissions or menu authorization |
| Episodic summaries | Derived summaries linked to underlying evidence and outcomes, marked stale when sources change; never authority to send or book |
| Feedback candidates | Proposed lesson from approve/edit/reject; not active policy or reusable instruction until reviewed |

### Controlled correction loop

1. Agent proposes or performs a permitted action. Keep action/run ID, scoped source
   records, prompt/model version, relevant memory/rule versions and the visible draft.
2. Manager approves, edits or rejects. Capture the original and final payload delta,
   reason (optional bounded input), actor role and time. Approval of one message is
   not approval of a generalized lesson.
3. Deterministic rules or a bounded extractor propose a structured candidate: type,
   subject, value, scope, source action/interaction, suggested applicability and expiry.
   Separate a one-off customer exception from a reusable shop preference. Lack of
   reason means “unknown,” not inferred intent presented as fact.
4. A permitted reviewer accepts, edits or rejects the candidate. Material shop rules,
   discounts, hours and permission changes require their normal domain authority;
   memory review cannot alter those domains through a back door.
5. Publish a versioned approved entry. New behavior cites it; superseded or revoked
   entries are excluded. Retain decision lineage for audit under a retention policy.

Example: manager changes “drop off at 8” to “drop off after 9.” Record the edit and
propose “customer X prefers drop-off after 9” if supported. Do not change the entire
shop's opening hours, permanently reschedule everyone or enable booking autonomy.
A manager rejecting a discount teaches no price rule until an explicit rule is
reviewed. STOP updates channel permissions through the consent mechanism immediately;
it never waits for memory review and cannot be undone by a remembered preference.

### Proposed record contract

Each approved memory/candidate needs `shop_id`, optional location/customer/vehicle,
kind, structured value, source/evidence references, author/reviewer identity, status
(candidate/approved/rejected/superseded/revoked), version, effective/expiry timestamps,
superseded reference and scope of use. Confidence is descriptive, never permission.
These are logical requirements, not new tables/migrations in this documentation pass.
Reuse existing entities and metadata where they preserve integrity; decide the small
reviewed-entry schema during implementation rather than adding another CRM store.

Retrieval order: verify actor/workspace/location → fetch canonical relevant records
and current permissions → fetch recent relevant conversation evidence → approved,
unexpired structured entries → optionally semantically relevant evidence. Limit by
customer/vehicle/task and token budget. Never retrieve globally and filter afterward.
No cross-shop cache keys; member/location restrictions also apply to retrieval results.
Customer-provided text or a retrieved document cannot supply instructions to tools.

If embedding/retrieval fails, retain source evidence and use structured facts/recent
history where adequate; otherwise ask or hold. Do not invent a remembered price or
availability. A vector score does not resolve ambiguous customer identity. Embedding
providers receive only allowed, minimized content; credentials, secrets and service
proofs are never memory.

### Correction, deletion and merge

Explicit corrections supersede older assertions; contradictory evidence stays visible
for review rather than being silently overwritten. Choose approved, current,
most-specific applicable information within policy caps; ambiguity produces a hold.
Deletion/retention must invalidate derived summaries, embeddings and caches, while
preserving only required audit data under the approved retention policy. Do not
invent a universal indefinite retention period.

**Pending PR #44** atomically merges customers, preserves destination-bound consent
and provenance, restrictive STOP/DNC/suppression, all eight child relationships and
pending references. Future memory references must join that transaction or be
explicitly invalidated atomically. Different destinations retain separate permissions;
merging identities never manufactures marketing consent. New memory types require
merge, rollback and deletion coverage before use.

## ARCHITECT FOR LATER

Support provenance, versioning, TTL and subject identity now so review and retention
can evolve. Embedding model/dimension changes require a versioned re-embedding and
cutover plan; do not swap providers over existing vectors silently. Curated recipe
promotion can use repeated reviewed lessons, with evaluation before publication.
Workspace rules may later specialize by location and service while preserving role
and policy ceilings. A derived summary is always reproducible from allowed sources.

## POST-MVP

Scheduled consolidation, richer relevance ranking, privacy-preserving aggregate
analytics and curation tooling follow the small reviewed-memory loop. No autonomous
code/prompt deployment, self-generated production skills, global customer memory
across unrelated shops, or fine-tuning on customer data by default.

## EXISTING SUPPORT

`src/lib/memory.ts` provides `recordInteraction`, recent history and scoped semantic
search; interactions still persist when embedding fails. `knowledge.ts` handles
shop knowledge chunking/retrieval. `embeddings.ts` centralizes the current embedding
provider; the schema uses 1536-dimensional vectors. `customer-context.ts`, `persona.ts`
and `whisper-summary.ts` supply shared context and summaries. `trust.ts` already
records approved-unedited, approved-edited and rejected outcomes. Reuse these.

## ARCHITECTURAL GAPS

Resolution counts do not capture the semantic before/after correction, distinguish
one-off exceptions or provide reviewed rule publication. No general structured
candidate → reviewer → approved-memory lifecycle was found. Retrieval lacks the
complete proposed review/expiry/member/location semantics. `whisper-summary.ts`
infers “prefers” from most-used inbound channel: this is observed usage, not explicit
preference and absolutely not consent. That wording/data distinction needs a bounded
follow-up. Historical “shared brain” claims overstate controlled learning.

Conflicts: old raw-memory/MCP examples imply that writing an interaction automatically
teaches the agent. It records evidence; it must not publish a rule. Trust graduation
and memory publication are separate decisions and must not become duplicate policy
engines. Keep one customer/vehicle identity spine and one channel-permission truth.

## FOUNDER DECISIONS

Approved: controlled learning from manager corrections; no self-modifying code;
consent preservation across customer merge. Open: which roles publish shop-wide versus
customer-specific preferences, retention durations for transcripts/deltas/rejected
candidates, and which low-risk explicitly supplied facts may update without a second
review. Proposed MVP: raw evidence logs automatically, extracted reusable rules remain
candidates; canonical facts follow normal CRM permissions. No inferred preference
automatically becomes consent or a shop-wide operating rule.

## ACCEPTANCE CRITERIA

- Approve/edit/reject yields traceable feedback; no candidate affects future actions
  before its required review. Publishing an approved preference changes a fixture's
  next draft, with source/version shown, without modifying code or permission.
- Conflicting, expired, revoked or wrong-shop/location memories cannot enter context.
  Revoked membership blocks retrieval and pending review actions.
- A corrected vehicle fact does not leak into another vehicle/customer; ambiguous
  identity requires clarification. An inferred channel habit never authorizes sending.
- Customer merges in both directions retain provenance and restrictive permissions;
  injected mid-merge failure rolls back added memory references with the other data.
- Deleting/superseding a source invalidates derived retrieval according to policy;
  an embedding outage still preserves permitted evidence without inventing facts.
- Prompt injection in a source, summary or suggested rule cannot change tools,
  service-purpose classification, recipient, policy or tenant boundaries.
