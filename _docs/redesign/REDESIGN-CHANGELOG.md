# Redesign changelog — `redesign/glass-box`

Full UI/UX overhaul + Glass Box transparency layer, July 2–6 2026.
Source of truth: `GRADIA-REDESIGN-SPEC.md` **including §8 amendments A1–A10**
(founder-decided; they win over §1–§7). PR: #2 (base `mvp/phase-0-subtraction`).

## Per-layer summary

| Layer | Commit | What shipped |
|---|---|---|
| **L0** | — | Inventory only: frontend map, Glass Box data map (found: no call table, no reasoning log, no webhook archive), doc-conflict list, risk list. Ten founder decisions recorded as spec §8. |
| **L0.5** | `5ca05ca` | Data capture, before anything visual: `call_records` (persists the Vapi end-of-call report previously dropped after metering) + `action_decisions` (the "because" line, written at all 15 staging sites in `agent-runtime.ts`/`vapi-tools.ts`). Both best-effort by contract — capture can never break call handling or billing (`eval/glass-box-capture.test.ts` locks it). |
| **L1** | `fbf3806` | Retheme: dark-first token system (silver scale, ONE accent `#7C3AED`, semantic status tokens w/ dark-canvas AA text variants, radii 6/10/16, motion 120/300ms, light theme defined-unshipped). Geist/Geist Mono type system, Instrument Serif retired. Cinematic layer off dashboard (public pages keep it). `docs/BUILD_REFERENCE.md` rewritten same-commit. Root-caused the sitewide heading-spacing bug (JSX transform strips element-adjacent spaces) → explicit `{" "}` in 20 files. |
| **L2** | `4f8b160` | Final IA: Home · Approvals(badge) · Activity · Conversations · Customers · Receptionist + pinned Numbers & Billing · Settings. Topbar = title · ⌘K composer (primary, untouched) · human-units usage pill · help. `/activity` route (taught empty state), `/conversations` (threads module + Ask Gradia behind its flag). `lenis` removed. Fixed pre-existing `/agents` 500 (icon component across RSC boundary). |
| **L3** | `1534674` | Screens: Home per A5 (receipt → KPI row w/ honest sparklines [drawn only when the 7-day series has ≥2 nonzero days] → Booked module → activity; co-owner nudges off). Approvals: narrator copy, equal-weight Send it/Tweak it/Drop it, Drop undo (`undoRejectFromDashboard`). Conversations: real thread list from stored turns. Skeleton `loading.tsx` everywhere. Welcome-modal "0 of 4live" fixed. `recharts` added (approved). New readers: `kpis.ts`, `appointments.ts`, `conversations.ts`. |
| **L4** | `95ab445` | The glass box: `/activity` real feed (call_records ∪ pending_actions ∪ fired runs; because-lines join from `action_decisions` only), `/calls/[callId]` per spec §5.2 canon (summary → outcomes → staged actions w/ decision lines → verbatim transcript → recording when captured). New readers: `activity.ts`, `call-records.ts`. |
| **Final** | this commit | Verification runbook: grep-clean (hexes = 3 documented exceptions), keyboard focus audit clean on all five screens, reduced-motion verified, **mutation-honesty test found + fixed a real gap** (network-level action failure was a silent stuck state; now rolls back with an error toast — verified live with the wire cut). Remaining chrome literals moved to `strings.ts`. |

## Route consolidation (all old URLs redirect, none dead)

| Old | New |
|---|---|
| `/agents` | `/receptionist` |
| `/agents/build` | `/receptionist/build` |
| `/agent` | `/receptionist` (composer lives in ⌘K/mobile overlay) |
| `/chat` (+`?c=`) | `/conversations` (+`?c=` preserved) |
| `/leads` | `/customers` |
| `/recovery` | `/customers/recovery` |
| `/schedule` | kept — full-list page off-sidebar; Home's Booked module is its front door (founder-approved) |

## Backend gap list

See `BACKEND-GAPS.md`. Headlines: nudge engine (post-alpha; NudgeCard only),
decision-log coverage excludes owner-agent + Twilio-SMS staging paths, no raw
webhook archive, no notifications/digest infra, no AI-disclosure setting, no
call-record backfill (capture starts at prod deploy).

## Known issues

- **Prod capture not live**: migration `20260702120000_glass_box_capture.sql`
  is NOT applied to production. Until it is, per-call summaries and decision
  lines are dropped, unrecoverable. Apply at merge.
- Pre-existing, untouched per test discipline: 3 telephony test failures
  (`ENCRYPTION_KEY` env in the test shell), 4 `roi-receipt.test.ts` tsc errors
  (missing `recoveredLeadsCount` in fixtures — belongs to the recovery branch).
- Hydration warning observed in dev when reduced-motion was flipped via
  emulation mid-session; worth one check on a real reduced-motion device.
- "Escalated" activity filter is intentionally disabled (no data can
  distinguish escalations yet — needs call-transfer capture).
- Conversations threads have no filters/search yet (no-results copy staged in
  `strings.ts`); voice thread rows link to the customer file, not per-call
  records (the Activity feed is the door to call records).
- Micro-literals remain in a few components (pill one-worders like
  "Confirmed"/"Booked", turn counts); page-level chrome is fully in
  `strings.ts`.

## Incidents & fixes (on the record)

1. **Prod session mint (July 2)**: the Layer-1 walkthrough minted a magic-link
   session against production Supabase — `.env.local` was a Vercel production
   pull, and nobody had checked. Side effects: auth-user timestamps + a
   welcome-modal dismissal flag on one shop. **Fix**: standing rule (never mint
   against prod; walkthroughs on the local stack), enforced structurally —
   `.env.local` now points at the local stack and the prod snapshot lives in
   `.env.production.pull`, which nothing loads. Documented in `LOCAL-DEV.md`.
2. **Local migrations drift (July 6)**: `supabase start` doesn't apply new
   migrations to an existing volume — the L0.5 tables silently didn't exist
   locally, and a seed insert against them had been failing without an error
   check. **Fix**: `supabase migration up` + re-grant procedure documented in
   `LOCAL-DEV.md`; seed scripts now check inserts.

## Honest assessment

The presentation layer is production-ready: tokens, IA, redirects, screens,
and the HITL flow are verified live, the suite/build never left baseline, and
the locked principles (HITL floors, no-send-tool, vendor seams, persona
no-touch) were extended rather than bent. What is *not* proven is the Glass
Box under real traffic: capture has run only against seeded local data, so the
first days after the prod migration will reveal how often Vapi's end-of-call
report is sparse (null summaries, missing durations) and whether the
because-line coverage (custom-agent + voice paths only) feels complete or
noticeably patchy to an owner — the UI degrades honestly in both cases, but
"honest and thin" is still thin. What scares me most about this branch in
prod: it has never rendered against the real production dataset — a shop with
hundreds of interactions, weird legacy payload shapes, or null-heavy rows
could surface layout breaks or slow queries (the activity/thread readers do
in-memory grouping over recent-N fetches, fine at pilot scale, unindexed
beyond it), and the redesign's merge with the in-flight recovery branch still
has one genuinely shared file (`(dashboard)/layout.tsx`) where a careless
resolution could drop the topbar or the composer. Recommendation: land
phase-0 → main first, rebase this PR, apply the migration, and smoke-test
`/activity` and one `/calls/[id]` against a real shop before announcing.
