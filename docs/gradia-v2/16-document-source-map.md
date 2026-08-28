# 16 — Document Source Map

_The reconciliation layer: every existing planning/spec/ops document, what it controls, its status, and who wins on conflict. Maintained by the Organizer. Created 2026-07-25._

## Precedence model (binding)

When sources disagree, the higher layer wins:

1. **Current audited application behavior** — `platform/docs/audit/` (2026-07-20) and, ultimately, the code itself.
2. **Approved Gradia v2 decision log** — `11-decision-log.md`.
3. **Approved Gradia v2 ADRs** — `adr/`.
4. **Approved Gradia v2 product principles and target architecture** — `00-product-principles.md`, `02-target-architecture.md`.
5. **Current `GRADIA_MVP_PLAN.md`.**
6. **Current feature-specific specifications** (`_docs/*_SPEC.md`, `docs/BUILD_REFERENCE.md`, redesign specs, `GRADIA_PRICING.md`).
7. **Historical project briefs and visions** (`PROJECT_BRIEF.md`, waitlist docs, positioning drafts they superseded).
8. **Run logs and temporary handoffs.**

Historical documents must not override audited current behavior or newly approved decisions. Note the deliberate asymmetry of layer 1: audited behavior wins on **what is true today**; the decision log wins on **what should become true** — a decision that contradicts current behavior (e.g. D-013) is a roadmap item, not a description.

Statuses: **CURRENT** (still governs its area) · **HISTORICAL** (kept for context; never build from it) · **SUPERSEDED** (a named doc replaced it) · **TEMPORARY** (run log/handoff/todo — point-in-time only).

---

## Inventory

### Governing instructions

| Path | Purpose | Status | Controls | Conflicts | Must read? | Gradia v2 governance |
|---|---|---|---|---|---|---|
| `~/Gradia/CLAUDE.md` (root) | Agent HQ: repo map, shared rules, locked principles, launch date | CURRENT | All agents' ground rules | — | **Yes (all agents)** | Points here; principles imported into `11` + `00` |
| `platform/CLAUDE.md` | Platform agent instructions (@-includes brief/plan/build-reference) | CURRENT | Platform work | Includes historical PROJECT_BRIEF verbatim (see C-02) | **Yes (Builder)** | `agent-briefs/claude-builder.md` |
| `platform/AGENTS.md` | "Read next/dist/docs — Next.js differs from training data" | CURRENT | Next.js coding | — | Yes (Builder) | `agent-briefs/claude-builder.md` |

### Product truth & commercial (layer 5–6)

| Path | Purpose | Status | Controls | Conflicts | Must read? | Gradia v2 governance |
|---|---|---|---|---|---|---|
| `platform/GRADIA_MVP_PLAN.md` | Working MVP build spec (2026-06-01); Phases 0–4 now built | CURRENT (layer 5) — build phases complete | MVP scope framing, golden rules | §5 lists `notifications` table + `shops.credit_balance` never built (C-03); §price superseded by pricing doc | Yes | Summarized by `00`,`01`; roadmap authority moved to `10-roadmap.md` |
| `_docs/GRADIA_PRICING.md` | Locked pricing/paywall/margins (2026-06-11/15) | CURRENT | All pricing claims + paywall behavior | Trial model amended by D-005 (C-04) | Yes (billing work) | `15-cost-and-margin-model.md` |
| `_docs/WHAT_GRADIA_DOES.md` | Product truth + claim discipline (2026-07-16) | CURRENT | Marketing/copy claims | "No invoicing/payments" is a current-claim, not permanent scope — D-019 schedules E05 (C-05); D-001 broadens category (C-01) | Yes (any copy) | `00-product-principles.md`; statuses machine-readable in `04` |
| `_docs/GRADIA_POSITIONING.md` | Category/positioning pivot (2026-06-12) | CURRENT | Messaging category | Extended by 07-16 "CRM that works itself" + D-001 | Copy work only | `marketing-site/` |
| `_docs/GRADIA_LAUNCH_GTM_PLAN.md` | 30-person GTM rollout plan (June 26 launch date) | HISTORICAL (dates stale; launch now 08-07) | — | Launch date drift (C-06); "founding" framings must pass D-003 | No | `13-release-strategy.md`, `marketing-site/` |
| `_docs/waitlist-landing-spec.md`, `_docs/waitlist-playbook.md` | Waitlist page + 10k playbook (7-agent era) | HISTORICAL | — | 7-agent framing vs current claims (C-02) | No | `marketing-site/` |
| `_docs/GRADIA_FEATURE_INVENTORY.md` | Full feature inventory for repositioning (2026-06-12) | HISTORICAL (audit 03 is the current matrix) | — | Statuses stale vs audit doc 03 | No | `04-capability-map.md` |
| `_docs/IDEAS_NOTES.md` | Founder raw idea capture | CURRENT (as inbox, never as decisions) | Nothing | — | No | Feeds `program/decision-queue.md` |
| `_docs/cost-model.html` | Interactive cost model | CURRENT (needs config update per pricing §open items) | Cost modeling | Default config predates 1,200-credit structure | No | `15-cost-and-margin-model.md` |

### Architecture & AI (layer 4–6)

| Path | Purpose | Status | Controls | Conflicts | Must read? | Gradia v2 governance |
|---|---|---|---|---|---|---|
| `_docs/GRADIA_AGENT_SHARPENING_BRIEF.md` + `platform/SHARPENING_BRIEF.md` | Locked agentic principles + P0–P5 work order (2026-06-09) | CURRENT (principles) / HISTORICAL (work order — built) | AI architecture invariants | — | Yes (AI work) | Principles imported into `11` + `02` |
| `platform/PROJECT_BRIEF.md` | Original 7-agent vision | HISTORICAL | Nothing (kept for history) | LangGraph, Text-to-SQL, $20/user, Make.com, Slack-first — all contradicted by code/decisions (C-02) | No (context only) | `00`, `02` |
| `platform/docs/mcp-architecture.md` | MCP/dev surface architecture | CURRENT | MCP surface | — | MCP work only | `02-target-architecture.md` |
| `_docs/GRADIA_CRM_INTEGRATIONS.md` | CRM connector architecture + how to add one (2026-06-15) | CURRENT | CRM seam | HCP endpoints unverified (audit) | CRM work | `02`, `vendors/customer-integrations/jobber.md`, `vendors/customer-integrations/housecall-pro.md` + `vendors/registry.md` (D-030 classifications win on provider status) |

### Feature specifications (layer 6)

| Path | Purpose | Status | Controls | Conflicts | Must read? | Gradia v2 governance |
|---|---|---|---|---|---|---|
| `_docs/GRADIA_TELEPHONY_VOICE_BUILDER_SPEC.md` | White-label numbers + voice builder (P6/P7) | CURRENT — built, awaiting live acceptance | Telephony/voice | A2P SIDs unverified live | Voice work | `04` (capability 20), `vendors/core/twilio.md`, `vendors/ai/vapi.md` |
| `_docs/GRADIA_CUSTOMER_RECOVERY_SPEC.md` | Import → recover → win-back (P8) | CURRENT — built, flag off, never live-smoked | Recovery | Lifecycle derivation unwired (audit) | Recovery work | `07-onboarding-and-imports.md` |
| `_docs/GRADIA_CRM_FOUNDATION_SPEC.md` | CRM foundation C1–C8 (P9) | CURRENT — code-complete, prod migrations/smoke outstanding | CRM surfaces | — | CRM work | `03-domain-model.md`, `05` |
| `_docs/GRADIA_UX_ONBOARDING_SPEC.md` | Onboarding wizard, 3-page IA, rename map | PARTIALLY SUPERSEDED by glass-box redesign (6-destination IA) | Onboarding UX intent | IA (3-page) vs BUILD_REFERENCE (6-destination) — redesign wins (C-07) | Onboarding work | `07`, `ui/flows/onboarding.md` |
| `_docs/research/GRADIA_CRM_PRODUCT_PLAN.md` + `_docs/research/*.md` | CRM product rationale + 11 competitor teardowns + SYNTHESIS | CURRENT (research) | Nothing directly | — | No | `research/README.md` |

### Design system & UI (layer 6)

| Path | Purpose | Status | Controls | Conflicts | Must read? | Gradia v2 governance |
|---|---|---|---|---|---|---|
| `platform/docs/BUILD_REFERENCE.md` | How Gradia looks/sounds/behaves (rewritten 2026-07-02, amended 07-16) | CURRENT | Every screen | §3 Home vs HOME_REDESIGN_PLAN item 9 legacy-tail wording (C-08) | **Yes (any UI)** | `ui/` mirrors and extends it |
| `_docs/redesign/GRADIA-REDESIGN-SPEC.md` (+ §8 amendments), `GRADIA-LANGUAGE-PACK.md`, `COMPONENT-SOURCING-MAP.md` | Full redesign spec, copy voice, component sourcing | CURRENT | Design tokens/voice/components | — | Yes (any UI) | `ui/design-tokens.md`, `ui/copy-guidelines.md`, `ui/component-inventory.md` |
| `platform/HOME_REDESIGN_PLAN.md` | Home rebuild decisions (2026-07-16; amends BUILD_REFERENCE §3) | CURRENT for the home-redesign branch | Home tab | C-08 (wins over older §3 text where they differ) | Home work | `ui/`; fold into BUILD_REFERENCE after merge |
| `platform/HOME_REDESIGN_HANDOFF.md` | Execution handoff for the plan | TEMPORARY | — | — | No | archive after merge |
| `platform/DESIGN.md`, `platform/HUMAN.md`, `platform/OPERATIONS.md` | Early one-page principles (Lovable-era) | HISTORICAL (superseded by BUILD_REFERENCE + Language Pack; HITL/we-us lines remain true) | — | "Lovable-style" aesthetic superseded by glass-box | No | `ui/design-north-star.md`, `ui/copy-guidelines.md` |

### Audit (layer 1)

| Path | Purpose | Status | Must read? | Gradia v2 governance |
|---|---|---|---|---|
| `platform/docs/audit/00–14 + GRADIA-AUDIT-FULL.md + gradia-audit.json` | Full technical audit, 2026-07-20, branch home-redesign | CURRENT — the layer-1 record | **Yes** (00, 12 for everyone; per-area docs per ticket) | `01-current-state.md` condenses; every P0 ticket cites it |

### Plans now absorbed by this roadmap

| Path | Purpose | Status | Gradia v2 governance |
|---|---|---|---|
| `platform/IMPLEMENTATION_PLAN.md` | MVP engineering execution plan (2026-06-01) | SUPERSEDED (phases built) | `10-roadmap.md` |
| `platform/MVP_GATING_PLAN.md` | Phase-0 hide-pass detail (2026-06-01) | SUPERSEDED (executed) | — |
| `platform/GRADIA_IGFB_CHARGE_REMOVAL_PLAN.md` | IG/FB/charge removal plan | SUPERSEDED (executed; code removed per audit 08) | — |
| `_docs/GRADIA_FOUNDATION_AND_PIVOT_PLAN.md` | CRM-first repositioning direction + file-by-file plan (2026-07-16) | PARTIALLY SUPERSEDED — direction absorbed into 00/10; file-level plan stale vs audit | `00`, `10` |
| `_docs/GRADIA_FOCUS_AND_UI_BUILD_SPEC.md` | NOW/NEXT roadmap for July-10 alpha (2026-06-16) | SUPERSEDED (built; dates stale) | `10-roadmap.md` |
| `platform/docs/project-status.md` | Status snapshot 2026-05-16 | HISTORICAL | `01-current-state.md` |

### Operations & go-live (current ops docs)

| Path | Purpose | Status | Must read? | Gradia v2 governance |
|---|---|---|---|---|
| `platform/GO_LIVE_CHECKLIST.md` | Deploy/smoke/flag-flip checklist (reconciled 07-08) | CURRENT | Yes (release work) | `13-release-strategy.md`, `releases/` |
| `platform/FOUNDER_OPS_RUNBOOK.md` | Founder-only account actions (07-08) | CURRENT | Founder | `runbooks/` complements |
| `platform/docs/*-go-live.md` (aurinko, calendar, jobber, meta, stripe, twilio, vapi) | Per-provider go-live runbooks | CURRENT (meta-go-live HISTORICAL — channel removed) | Provider work | `vendors/*` link to them |
| `platform/docs/env-setup.md`, `outbound-sms.md`, `outbound-email.md`, `OVERUSAGE_RUNBOOK.md`, `demo-scripts.md`, `operator-playbook.md` | Env, channel ops, overusage, demos, owner playbook | CURRENT | Per area | `08`, `runbooks/` |

### Run logs, handoffs, todos (layer 8 — TEMPORARY, never build from)

`platform/OVERNIGHT_REPORT.md`, `OVERNIGHT_RUN_2026-07-08.md`, `RUN_2026-07-09_CRM_C3_C2.md`, `RUN_2026-07-09_CRM_C4_C5.md`, `RUN_2026-07-10_CRM_C6_C8.md`, `RUN_2026-07-13_FIX_PASS.md`, `PR_BODY_phase0.md`, `GRADIA_AGENT_HANDOFF.md`, `GRADIA_AGENT_MERGE_BRIEF.md`, `FOUNDER_TODO_2026-07-09.md`, `_docs/DAY_RUN_2026-06-12.md`, `_docs/OVERNIGHT_REPORT.md`, `_docs/OVERNIGHT_RUN_2026-06-11.md`, `_docs/HANDOFF_CLAUDE_CODE_2026-07-13.md` — all TEMPORARY. One caveat: `platform/OVERNIGHT_REPORT.md` is cited by WHAT_GRADIA_DOES for C1–C8 test evidence; keep until `04-capability-map.md` carries that evidence.

---

## Contradiction register

| ID | Contradiction | Resolution |
|---|---|---|
| C-01 | D-001 "operating system for detailing shops" vs WHAT_GRADIA_DOES "CRM that works itself" headline + retired "AI office" framing | **Updated 2026-07-27:** D-033 resolves the category question — marketing adopts the OS category + "Run your shop. Capture every lead. Recover more revenue." headline. WHAT_GRADIA_DOES still governs per-feature *claims* (D-028) until the founder updates its claim list; its headline line is now stale and needs that founder update. |
| C-02 | `PROJECT_BRIEF.md` (and waitlist docs): 7 agents, LangGraph, Text-to-SQL, Slack-first HITL, $20/user, Make.com | Historical. Code + D-009/D-010/D-026 win. Brief stays for history; recommend an accuracy banner (audit Q20). Note: `platform/CLAUDE.md` still @-includes it — future agents must treat it as layer 7. |
| C-03 | `GRADIA_MVP_PLAN.md` §5 `notifications` table + `shops.credit_balance` | Never built (correctly — balance is ledger-derived). Audit doc 05 wins. Plan needs a correction note. |
| C-04 | GRADIA_PRICING "free = explore only, cannot run agents or send" vs D-005 full operational trial | D-005 wins going forward; pricing doc needs a trial section amendment (decision queue Q-13 holds the allowance numbers). |
| C-05 | WHAT_GRADIA_DOES §3 "no invoicing / payment collection" vs D-019 Stripe-Connect-first payments (E05) | Both true at different layers: current claims list stays accurate until E05 ships; D-019 sets build direction. |
| C-06 | Launch dates across docs: June 26 (GTM), July 10 (focus spec), Aug 7 (current) | Root CLAUDE.md (Aug 7) wins. GTM/focus docs marked historical. |
| C-07 | UX_ONBOARDING_SPEC 3-page IA vs BUILD_REFERENCE 6-destination IA | Redesign (BUILD_REFERENCE) wins; onboarding-wizard content of the UX spec remains valid. |
| C-08 | BUILD_REFERENCE §3 vs HOME_REDESIGN_PLAN item 9 on the legacy Home tail (audit Q21) | The plan wins on the branch (page follows it); reconcile BUILD_REFERENCE §3 text when home-redesign merges. |
| C-09 | D-013 (Gradia DB = appointment source of truth) vs audited behavior (booking hard-requires Aurinko; external calendar authoritative) | Layer-1 describes today; D-013 is direction, delivered by E02 (P2). Until then the Aurinko dependency stands and P0-003/004 build conflict checks on the current model. |
| C-10 | D-018 (tenancy before major schema expansion, P1) vs audit doc 11/12 sequencing members at P3/90d+ | Decision log wins: tenancy is pulled forward to P1. |
| C-11 | MVP plan "gate, don't delete" vs actual hard deletion of IG/FB code | Superseded in practice by the removal plan (executed); audit doc 08 records the residue as harmless. Accept. |
| C-12 | `agents.ts` receptionist catalog copy describes the retired Slack approval flow; `data/customers.ts` docstring claims IG/FB search | Code-comment/copy drift, not doc conflict; **resolved 2026-08-28 by P0-010 (PR #27)** — catalog rewritten to in-app Approvals/Conversations, docstring matches the code. |
| C-13 | Audit doc 12 recommends warn-and-override for HITL booking conflicts; older assumption was hard-block everywhere | Settled by D-015/D-016: hard-block automatic, warn-and-override (documented) for humans. |
| C-14 | D-031 three-tier pricing (Core $99 / Pro $149 / Operator $249, founder master definition 2026-07-27) vs `GRADIA_PRICING.md` locked $20/+$29 **and** live billing/Stripe products that still charge $20/$29 | D-031 wins as forward direction (layer 2); the $20/$29 model remains the accurate layer-1 description of live billing until Q-22 resolves tier split/allowances/timing and the migration ships. `GRADIA_PRICING.md` requires a founder rewrite; `15-cost-and-margin-model.md` carries a banner and re-derives floors after Q-22. Every gradia-v2 doc quoting $20/$29 is describing current behavior, not the destination. |
| C-15 | Planning docs (`06-ui-information-architecture.md`, `ui/navigation-model.md`, BUILD_REFERENCE §2) state "exactly six" sidebar destinations — `navigation-model.md` even claimed it was "verified in code" — vs the live sidebar, which ships **seven** (Calendar added in commit `3a06340`, `app-sidebar.tsx`) | Layer 1 wins: seven destinations is current truth; the planning docs were corrected 2026-07-27. Q-15 reframed to ratify-or-revert; BUILD_REFERENCE §2 amendment rides the Q-15 resolution. The founder's 9-item target IA (Home/Inbox/Calendar/Customers/Sales/Jobs/Gradia/Reports/Settings) is held in Q-23 as the convergence target, not silently adopted. Stale code comment ("exactly these six") did not ship with P0-010 (out of cut scope; done 2026-08-28) — cosmetic follow-up in `program/backlog.md`. |

## Archival recommendations (for human approval — NOT performed this session)

- **Retain as source material:** all `_docs/*_SPEC.md`, GRADIA_PRICING, WHAT_GRADIA_DOES, POSITIONING, BUILD_REFERENCE + redesign docs, audit directory, go-live/ops docs, research/.
- **Mark historical (add a one-line banner):** PROJECT_BRIEF.md, waitlist-landing-spec.md, waitlist-playbook.md, GRADIA_LAUNCH_GTM_PLAN.md, GRADIA_FEATURE_INVENTORY.md, DESIGN.md, HUMAN.md, OPERATIONS.md, docs/project-status.md, docs/meta-go-live.md.
- **Mark superseded (banner pointing at successor):** IMPLEMENTATION_PLAN.md, MVP_GATING_PLAN.md, GRADIA_IGFB_CHARGE_REMOVAL_PLAN.md, GRADIA_FOCUS_AND_UI_BUILD_SPEC.md, GRADIA_FOUNDATION_AND_PIVOT_PLAN.md (file-level plan only).
- **Archive after human approval** (move to `platform/docs/runs/` or `_archive/`): all TEMPORARY run logs/handoffs/todos listed above, after the home-redesign branch merges and the founder confirms nothing is still in flight; `HOME_REDESIGN_PLAN.md` only after its content folds into BUILD_REFERENCE §3.
