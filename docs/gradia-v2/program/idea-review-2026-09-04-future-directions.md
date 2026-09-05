# Idea review — "Future directions" (6 theses + prototype architecture)

_Reviewed 2026-09-04 against the codebase at HEAD (`e1f09c6`) and `platform/CONTEXT.md` (2026-09-03). Filed here per CONTEXT.md §8: new ideas do not enter the build mid-week. Nothing in this document is a ticket._

---

## Verdict in one paragraph

Four of the six theses describe systems **you have already built** and are underrating. The prototype architecture at the bottom of the document would **replace working code with a strictly worse version of itself**, and its own footnotes admit why. The single most valuable sentence in the whole document is buried as a caveat — "Supabase credentials operating as `service_role` can bypass RLS" — because that is not a hypothetical for a future prototype, it is the live state of the platform today. Two of the six theses (agent-to-agent commerce, developer platform) are unbuildable in principle right now for a reason that has nothing to do with engineering: they are network and ecosystem plays, and you have zero paying shops, no carrier-approved SMS, and a voice product that has never completed a verified real call. The document is a good map of where this category is going. It is a bad map of what to do next, and reading it as the latter is the exact failure mode CONTEXT.md §8 was written to prevent — this was drafted the day after the product was redefined four times in one afternoon.

---

## 1. What the document proposes as "future research" that is already in `src/lib`

| Thesis | What exists today | Evidence |
|---|---|---|
| "Shared memory could grow into a connected model of the business" | Shipped. pgvector interactions with per-customer + cross-channel recall, chunked shop knowledge with the same embedding model and RLS pattern, one persona, one pricing module — all feeding voice, quotes and drafts identically. | `memory.ts` (209 L), `knowledge.ts` (290 L), `embeddings.ts`, `persona.ts`, `customer-context.ts`; `match_customer_memory` RPC |
| The structured-vs-RAG access table ("exact DB queries for bookings, RAG for policies") | This is a **description of your implementation**, not a proposal. 14 fixed query builders sit beside `search_memory` / `search_knowledge`. Text-to-SQL was explicitly rejected. | `bi-tools.ts` (876 L); roadmap §"deliberately rejects" |
| "Approval Mode could evolve into the control system behind autonomy" | It already is one: atomic claim, edit-then-approve, undo, rollback-on-failure, per-action-type approval telemetry, and an evidence-based autopilot recommendation at 15 decisions / 90% unedited. | `approvals.ts` (2,167 L), `trust.ts`, `autonomy.ts`, `action_decisions` |
| "Expose capabilities to partners and developers" | An authenticated MCP server with 12 tools, SHA-256 hashed bearer tokens, per-token daily caps, shop-bound identity. Your document never mentions it. | `lib/mcp/server.ts` (874 L), `mcp/auth.ts`, `mcp_tokens` + rate-limit migrations |

**That last row is the tell.** You wrote a six-thesis vision about agent-to-agent interoperability and a developer platform without mentioning that you shipped the interoperability surface in May. The vision was written from memory of the category, not from the repo.

---

## 2. Four claims in the document that are wrong about your own system

**2.1 — The "Cursor SDK agent" in the architecture diagram should be deleted.**
You already have the runtime: `agent-runtime.ts` (2,154 L), `agent-planner.ts`, `RECIPE_HANDLERS`, `EVENT_RECIPE_HANDLERS`, `runScheduledAgents`. Locked principle #5 and D-010 reject agent-framework migration; hand-rolled SDK calls are a recorded decision, not an accident. Worse, the document's own footnote concedes that Cursor's custom tools **execute without interactive approval** and that tool restrictions must be reapplied on resume. So the proposal is: adopt a runtime whose default behaviour violates Guardrail #1, then rebuild Guardrail #1 outside it, and carry a resume-time re-restriction bug class you do not have today. There is no capability in that box you do not already have.

**2.2 — "The database enforces access" is aspirational, not current.**
`forShop()` — the mechanism that makes tenancy structural rather than per-line discipline — is adopted at **2 call sites**. `src/lib` alone contains ~221 raw `.from("…")` calls, and 32 files construct or use a service-role client. Your own Guardrail #5 says it: *"Service-role Supabase bypasses RLS — `.eq(\"id\", …)` alone is not authorization."* ADR-003 describes the full migration as a follow-up ticket set that was never cut. This is the real finding in the document and it is filed as a footnote about a hypothetical prototype.

**2.3 — The flagship example for thesis #1 half-cascades. CORRECTED 2026-09-04 (evening) — the original wording here overstated it.**
"Changing a service's duration affects availability, quotes, staffing, and customer promises." What is actually true at `auto/b-16-0903-2010`:
- **Quoting cascades.** `quotes.ts:68` calls `resolveDurationMinutes(service, sizeClass)` with a real size class, so a quote's duration is size-aware.
- **Voice booking cascades on the flat value only.** `lookupServiceDuration` (`vapi-tools.ts:221`) selects `name, duration_minutes` from `services` and passes the result into the booking proposal — it never reads `duration_by_size`, and it does not go through `resolveDurationMinutes`.
- **Availability does not cascade at all.** `availability.ts` contains no reference to the `services` table (13 modules query it; the availability engine is not one). Slot/conflict math falls back to `DEFAULT_DURATION_MINUTES = 90`.
- **Size-class durations are dropped at 7 of 8 `resolveDurationMinutes` call sites** — `drafting-context.ts:49`, `vapi-prompt.ts:121`, `vapi-tools.ts:494` and `:502` all call it with no `sizeClass`, so the agent *says* the flat duration while a quote *computes* the sized one. B-16 makes this newly visible by collecting per-size durations in onboarding.

So the correct framing is not "build a consequence engine." It is: one read path (availability) and one seam (size-class propagation) are unwired, and B-16 just increased the cost of leaving them that way. Verify at the call sites before acting — this is grep-level evidence, not an audit.

**2.4 — "Multimodal Whisper" is a reversal of a decision you made 24 hours earlier, not an extension.**
`whisper.ts` classifies into exactly two intents: `create_lead | add_note`. There are zero vision-model calls anywhere in `src/`. `photos_before` / `photos_after` exist as bare string arrays touched only by `actions/jobs.ts`. And CONTEXT.md §2 (D-067) cuts **photo-based quoting** from scope entirely, alongside jobs and work orders — which is the surface the walk-around-the-vehicle scenario writes to. If you want this, it is a founder decision to reverse D-067 with a recorded reason. It is not a research direction.

---

## 3. Ranking, worst to best

**#6 Developer platform / industry apps — premature by ~2 years.** A platform is a bet that your primitives are dependable enough for someone else to build a business on. Conflict enforcement is off in production; double-booking is possible today. You cannot rent out reliability you do not yet have.

**#5 Agent-to-agent commerce — right thesis, wrong company-stage.** A2A and commerce protocols are real and worth tracking. But network value scales with participants and you have zero shops. A fleet company's agent asking your shops for availability requires shops. Revisit at 50 paying shops; the MCP server already means the technical cost of entering later is low. That is a reason to *wait*, not a reason to move.

**#1 Persistent business intelligence / operational digital twin — the weakest thesis on its own merits.** "What changes if we add another technician" is a question a 6-person detail-shop owner answers in his head in ten seconds, using knowledge you cannot get into the model. A single shop generates far too little data to fit duration or capacity models that beat the owner's intuition, and being confidently wrong about job durations is worse than silence. This is an enterprise planning feature sold to an SMB that has not asked for it. The *connected-state* half (memory, retrieval, one pricing source) is real and built. The *simulation* half should be dropped.

**#3 Multimodal Whisper — good instinct, blocked by your own scope cut.** Standing at a car and talking is genuinely the right interface for this user; it is also the one place a detail shop's real bottleneck (condition assessment) meets a model capability. But it lands in cut scope, and it is worthless before the agent can quote at all (B-16). Park it behind a real customer asking.

**#4 Learning from outcomes — contains the one cheap, compounding, do-it-now item.** See §4.

**#2 Agents that own ongoing outcomes — this is the actual product, and it is ~70% built.** D-068's ladder (reversibility × blast radius × consent), `trust.ts`'s per-action-type earned autonomy, non-bypassable consent / quiet hours / STOP in `send-policy.ts`, and the four-layer audit trail are, together, the thing nobody else in this vertical has. Your own competitive note says dreamteam.co is *more* conservative — every action is a draft card. The moat is not "long-running agents"; it is **being the only one who can safely let them act in a $500–$1,500-per-message TCPA environment**. That is B-17, already written, already ordered.

---

## 4. The one thing in this document worth doing soon

**Every day you throw away the best training data you will ever have.**

`pending_actions` stores a single `payload` blob and a `resolution` enum. The edit-then-approve flow (`markEditRequested` → re-approve) leaves **no record of the original draft**. Grep confirms: no `original_payload`, no `edited_payload`, no diff column anywhere in `src/` or `supabase/migrations/`. So `trust.ts` knows an owner edited a text, and never what they changed.

That diff is free, shop-specific, human-labelled supervised data about voice, pricing language, and what an owner will not say to a customer. It is the honest version of thesis #4 — no specialised duration models, no cross-business learning, no permission regime. One column, one write at edit time, backfill impossible so the cost of waiting is permanent.

It is small enough to sit behind the §4 build list without disturbing it, and it makes B-17's earned-autonomy ladder measurably better rather than speculatively better.

## 4b. And the experiment you proposed is the right experiment aimed at the wrong target

Two fictional shops, identical customer names, cross-shop access probes, duplicate events, an injected customer message. Run it — **against the runtime you have**, not a Cursor prototype. It is a red-team of ADR-003's unfinished tenancy mechanism (§2.2), and it is the only cheap way to find out whether ~221 unscoped query sites hold. Rename it from research to what it is: a security acceptance run.

---

## 5. What acting on this document now would cost

CONTEXT.md §3, dated yesterday: no A2P Brand, no A2P Campaign — **SMS cannot legally send**. Voice: never verified on a real call. Billing: 80% written, on an unmerged branch. Open work: 18 B-tickets, 16 adoption blockers, of which A-01 (phone-number continuity) is described in your own file as "the highest-value missing item in the product."

Zero shops are paying. Nothing in this six-thesis document moves any of that. Everything in it is a reason to feel excited on a day when the honest work is registering a brand with a carrier and making one phone call ring.

The document is a good artefact — keep it, revisit it at 50 shops, and let it shape which tickets you write in *what order* rather than which tickets you write *instead*. Ship B-02 through B-10 first.

## 6. Recommended disposition

- Fold §4 (edit-delta capture) into the build list as a small ticket after B-04. It is the only new build this review endorses.
- Fold §4b (two-shop red team) into the P0 security re-score as an acceptance run; it is not a new feature.
- Add §2.3 (availability ↔ service menu wiring) as a note on B-16(a) — it is likely already in scope, confirm rather than duplicate.
- Everything else: hold as a Q-26 decision-queue entry, reviewed at the Monday update, revisited at 50 paying shops.
- Explicitly reject the "Cursor SDK agent" runtime (§2.1). If it is ever reopened it needs an ADR against D-010, not a diagram.
