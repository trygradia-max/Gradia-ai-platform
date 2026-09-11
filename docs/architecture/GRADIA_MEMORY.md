# Gradia Memory

> Planning baseline: `main` at `20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5`, plus
> verified draft [PR #44](https://github.com/trygradia-max/Gradia-ai-platform/pull/44)
> at `3b99bf4b5d9022a248bd1716fe2b070d8ae455f5`. PR #44 is **pending, not merged**.
> This documentation branch starts at that reviewed head to describe its safety
> boundaries accurately; inherited changes are not new documentation-phase implementation.
> Founder decision package **approved September 11, 2026**. These product requirements
> are decided; implementation contracts remain designs, not claims of built behavior.
> Source review: 2026-09-10 (local). Static inspection and prior verification are
> distinguished from live acceptance. No production access or live model evaluation.
> The approved founder decision package governs these requirements where older
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
4. A permitted reviewer accepts, edits or rejects the candidate. Managers publish
   customer-specific preferences within scope; owners approve shop-wide rules and
   policies; staff may propose candidates. Explicit human CRM edits need no second
   memory approval; model-generated reusable lessons do. Material shop rules,
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

### Retention defaults

**Approved September 11, 2026 as provisional product defaults.** They must match
the final privacy policy and receive privacy/legal review before production.

| Data class | Provisional default |
| --- | --- |
| Raw audio | 30 days |
| Message and transcript content | 12 months |
| Rejected memory candidates | 90 days |
| Approved structured memory | Until superseded, expired or deleted |
| Consent, suppression, proof-replay tombstones and minimum safety/audit evidence | Separate safety-retention policy |

Routine cleanup must never erase suppression evidence, recreate consent or reopen
a consumed action. Deletion of content and retention of minimal safety evidence are
separate operations. The final safety-retention schedule requires privacy/legal
review; this document neither invents a duration nor authorizes cleanup jobs.

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

**Approved September 11, 2026:** operational memory never crosses shop boundaries.
Managers may publish customer-specific preferences within authorized scope; owners
approve shop-wide rules and policies; staff may propose candidates. Explicit human
CRM edits need no second memory approval. Model-generated reusable lessons require
publication approval. Learning uses structured evidence, candidates, rules,
preferences and versioned evaluations, never uncontrolled code modification.
Important memory changes retain provenance, appropriate expiry, supersession and audit.

Retention defaults above are decided but provisional pending privacy/legal review
before production, including the separate safety-retention policy. Those are review
obligations, not a reason to reopen memory-publication authority or consent safety.

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
- Role tests prove managers cannot publish shop-wide rules, staff cannot publish
  candidates, and authorized human CRM edits require no second approval. Every
  publication records reviewer, version and source.
- Clock-controlled retention tests verify the 30-day, 12-month and 90-day boundaries,
  source/derived invalidation and approved-memory supersession/deletion. Routine
  cleanup cannot remove suppression or reopen a consumed proof. Production cleanup
  remains gated on privacy/legal approval of the final policy.
- Prompt injection in a source, summary or suggested rule cannot change tools,
  service-purpose classification, recipient, policy or tenant boundaries.
