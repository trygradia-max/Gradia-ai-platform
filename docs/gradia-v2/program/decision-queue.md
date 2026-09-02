# Program — Decision Queue

_Created 2026-07-25 by the Organizer. Open founder-level decisions. **None below is decided** — every item requires explicit founder approval; on approval the Organizer records it in `../11-decision-log.md` (and an ADR where it's an architecture mechanism) and removes it here. Agents never resolve these silently (Builder contract / D-026-style locks)._

Format per item: context · options · Organizer recommendation · what it blocks.

_Batch resolution 2026-09-01 (autorun prep, `11-decision-log.md` Batch 5): Q-01/02/03/05/07/08/09/11/12/15/16/17/19/21/23/25 resolved → D-038…D-052; tombstones below. **Still open:** Q-04 (expired-quote re-quote CTA), Q-10 (archival), Q-18 (Connect platform fee, E05), Q-20 (Jobber posture post-parity), Q-24 (membership auto-renewal, E06)._

---

## Q-01 — RESOLVED 2026-09-01 → D-038 (rotate only, no git-history scrub; documented as compromised-and-rotated). Tombstone preserves numbering.

## Q-02 — RESOLVED 2026-09-01 → D-039 (lifecycle thresholds 180/365 approved as implemented; configurable only if pilots ask; wiring = ticket E03-03). Tombstone preserves numbering.

## Q-03 — RESOLVED 2026-09-01 → D-040 (direct customer create/edit was an omission — built in E03, ticket E03-01). Tombstone preserves numbering.

## Q-04 — Expired-quote visitor UX

- **Context:** P0-009 enforces `valid_until` server-side (done 2026-08-26); what does a visitor to an expired `/q/[token]` see beyond the minimal honest state?
- **Options:** dead end; "this quote expired — ask for a fresh quote" CTA that stages a lead/notification.
- **Recommendation:** the CTA — it converts an expiry into a lead instead of a dead end.
- **Blocks:** ~~final copy/behavior in P0-009~~ — P0-009 shipped **2026-08-26 (PR #25)** with the minimal honest expired state, exactly as planned. Q-04 remains open and now gates only the richer re-quote CTA (an expiry-to-lead conversion surface — no ticket exists for it yet; the Organizer cuts one when the decision lands).

## Q-05 — RESOLVED 2026-09-01 → D-041 (operator quick-reply to an opted-out customer: warn-but-allow, implemented in the E07 composer). Tombstone preserves numbering.

## Q-06 — RESOLVED 2026-09-01 → D-053 (nightly eval + CI path filter on prompt changes)

## Q-07 — RESOLVED 2026-09-01 → D-052 (Slack approvals surface deleted in Batch 1, ticket CLEANUP-001; amends D-026). Tombstone preserves numbering.

## Q-08 — RESOLVED 2026-09-01 → D-042 (founder Slack ops channel for all alerts + SMS for SEV-0/1; P0-012 step 6 unblocked; seam ships even if the webhook is not yet configured). Tombstone preserves numbering.

## Q-09 — RESOLVED 2026-09-01 → D-043 (Google-first, Microsoft fast-follow within E02; with D-050 the Microsoft path is a direct Graph adapter, ticket E02-04). Tombstone preserves numbering.

## Q-10 — Archival approval

- **Context:** `../16-document-source-map.md` §Archival recommends banner-marking historical/superseded docs and moving run logs to `platform/docs/runs/` or `_archive/`.
- **Options:** approve the list as-is; edit the list; defer.
- **Recommendation:** approve after home-redesign merges (several TEMPORARY docs are still referenced until then).
- **Blocks:** the archival sweep (explicitly NOT performed in the Organizer's creation session).

## Q-11 — RESOLVED 2026-09-01 → D-044 ($500 high-ticket threshold, owner-configurable upward only, enforced in `isAutonomyAllowed()` and test-locked). Tombstone preserves numbering.

## Q-12 — RESOLVED 2026-09-01 → D-045 (own-database, RLS-scoped product-analytics events table first; no vendor). Tombstone preserves numbering.

## Q-13 — RESOLVED 2026-08-28 → D-035 (trial: 14d from activation, card-to-convert, 500 credits + 15 min)

- **Context:** D-005 approves a full operational trial with controlled variable-cost allowances; the numbers are unset. GRADIA_PRICING's "free = explore only" paywall text needs a trial amendment (contradiction C-04). **Amended 2026-07-27:** D-032 fixes that the trial starts after *meaningful setup or activation*, not email signup — the definition of that activation gate (which onboarding steps count: e.g. import committed, service menu saved, calendar connected, first simulated workflow run) is now part of this decision. Allowance numbers must also be re-derived against D-031 three-tier pricing (Q-22), not the $20/$29 model.
- **Options:** founder sets length + allowances + the activation-gate step list.
- **Recommendation:** 14-day clock starting at activation (gate = import committed OR service menu + calendar connected, per D-032) · allowances sized under Q-22 tier economics · existing fail-closed machinery enforces; card-optional at start, card required to convert.
- **Blocks:** trial build in E01/billing; GRADIA_PRICING amendment; `ui/flows/trial-to-paid.md` final states.

## Q-14 — RESOLVED 2026-07-27 → D-033

Marketing category language: resolved by the founder master product definition — OS category + "Run your shop. Capture every lead. Recover more revenue." headline adopted. Recorded as **D-033** in `11-decision-log.md`; C-01 updated. Per-feature claims still pass D-028/WHAT_GRADIA_DOES discipline. (Entry retained as a tombstone to preserve Q-numbering.)

## Q-15 — RESOLVED 2026-09-01 → D-046 (Calendar ratified as the seventh sidebar destination; BUILD_REFERENCE §2 amendment flagged; C-15 resolved). Tombstone preserves numbering.

## Q-16 — RESOLVED 2026-09-01 → D-047 (Reports under Numbers & Billing; no eighth destination). Tombstone preserves numbering.

## Q-17 — RESOLVED 2026-09-01 → D-048 (member roles owner / admin / tech; custom roles deferred; binds E01-01/E01-03/E04-04). Tombstone preserves numbering.

## Q-18 — Platform fee on Stripe Connect payments (E05)

- **Context:** D-019 approves Stripe Connect for customer payments; whether Gradia takes an application fee on shop transactions (and how that squares with the pricing doc's margin rules) is undecided.
- **Options:** no platform fee (subscription-only revenue); small application fee; fee only above a volume tier.
- **Recommendation:** no platform fee at E05 launch — keep the "$20 promise fully true" spirit; revisit with real volume data.
- **Blocks:** E05 billing design and pricing-doc amendment.

## Q-19 — RESOLVED 2026-09-01 → D-052 (Housecall Pro connector deleted in Batch 1, ticket CLEANUP-001; P3-001 superseded — its inventory executes inside CLEANUP-001). Tombstone preserves numbering.

## Q-20 — Jobber: keep as migration/temporary-sync connector after parity?

- **Context:** Jobber is **optional** (D-030): one-way best-effort push behind `crm-provider.ts`, feature-flagged, useful for migration and temporary synchronization while Gradia reaches CRM parity (E03).
- **Options:** keep optional/demand-driven; deepen to bidirectional sync; sunset after parity.
- **Recommendation:** *keep optional and customer-demand driven; never make it a core dependency.* Re-evaluate ongoing synchronization after Gradia reaches operational parity (post-E03).
- **Blocks:** E03 import-wizard scope for Jobber-sourced migration; nothing in P0.

## Q-21 — RESOLVED 2026-09-01 → D-050 (Aurinko replaced by direct Google Calendar/Gmail + Microsoft Graph adapters behind `CalendarProvider`/email seam in Batch 4 — tickets E02-03/E02-04/E02-06; Aurinko retired at Batch-4 end). Tombstone preserves numbering.

## Q-22 — RESOLVED 2026-08-28 → D-034 (tier split + allowances; implementation remains ticket P0-013)

- **Context:** D-031 (founder master definition, 2026-07-27) re-bases public pricing to Core $99 / Pro $149 / Operator $249. Everything downstream is unset: the docs' margin floors, credit menu, and $49-full-stack framing (`../15-cost-and-margin-model.md`) are derived from the superseded $20/$29 model, live Stripe products still bill $20/$29, and the trial allowances (Q-13) were sized against the old model. Contradiction C-14.
- **Options (founder sets each):** (1) tier feature split — what Core vs Pro vs Operator each include (voice, autonomy, seats, locations, allowances); (2) included credit/minute allowances per tier + re-derived margin floors (keep the ~3.3×-wholesale / ≥~67%-margin rules or re-set them); (3) adoption timing — before alpha (2026-08-07), at alpha, or post-alpha relaunch; (4) existing pilot/shop migration — grandfather, migrate with notice, or none exist to migrate.
- **Recommendation:** decide the tier split and allowances before any marketing pricing page or trial build; do not touch live billing during P0. Rewrite `_docs/GRADIA_PRICING.md` (founder-owned, outside gradia-v2) as the implementation act; `15-cost-and-margin-model.md` then re-derives floors.
- **Blocks:** marketing-site pricing page; trial-allowance numbers (Q-13); Stripe Billing product setup; `15-cost-and-margin-model.md` re-derivation; Q-18 framing ("the $20 promise" language is now stale); **P0-013 — Production billing model alignment** (the implementation ticket for this decision, cut 2026-08-28 at the P0-010 close as draft — decision-gated; `../tickets/P0-013-production-billing-model-alignment.md`).
- **Update 2026-08-28 (P0-010 close):** the production env exception is now on record — `STRIPE_PRICE_ID` / `STRIPE_PRICE_VOICE_ADDON` / `STRIPE_PRICE_CREDIT_PACK` / `STRIPE_PRICE_MINUTE_PACK` are intentionally **absent from Vercel Production**, and the P0-010 founder acceptance proved subscription/pack checkout fails closed **before any Stripe API call** with no charge and no local state change. That absence is the standing safety guard: nobody instructs setting those variables until P0-013 is implemented, reviewed, accepted, and ready for Production. **P0-013 is launch-blocking before live paid billing activation**; P0-011/P0-012 proceed independently of it.

## Q-23 — RESOLVED 2026-09-01 → D-049 (keep the shipped IA through alpha; the 9-item model is the recorded target, converged per phase via BUILD_REFERENCE §2 amendments). Tombstone preserves numbering.

## Q-24 — Membership auto-renewal vs the money-HITL floor (E06)

- **Context:** Locked principle #4 / D-021: money writes are always HITL — "no mode, flag, or refactor bypasses this." E06 memberships require recurring billing: charging a renewal every month cannot practically wait for a human click per charge. E06's draft treats "owner approves the series once; code executes each renewal" as a documented exception locked by a future ADR — but reinterpreting the floor is a **founder** decision, not an ADR mechanism choice.
- **Options:** (a) series-level consent: the owner (and the end customer, via Stripe mandate) approves the membership once; each renewal executes deterministically with full audit + failure-to-HITL escalation; (b) per-renewal approval (defeats the product); (c) no membership auto-billing (defeats E06).
- **Recommendation:** (a) — consent-at-enrollment is the industry-standard recurring-billing model and preserves the floor's intent (no *AI-initiated* money movement without approval; renewals are owner-configured schedule execution, not agent discretion). On founder approval, record as D-03x and write the mechanism ADR before E06 build.
- **Blocks:** E06 membership-billing ticket cutting (P6); nothing earlier.

## Q-25 — RESOLVED 2026-09-01 → D-051 (the alpha date follows the P0 exit gate; no new date set; gate not split; WIP limits unchanged). Tombstone preserves numbering.
