# Program — Decision Queue

_Created 2026-07-25 by the Organizer. Open founder-level decisions. **None below is decided** — every item requires explicit founder approval; on approval the Organizer records it in `../11-decision-log.md` (and an ADR where it's an architecture mechanism) and removes it here. Agents never resolve these silently (Builder contract / D-026-style locks)._

Format per item: context · options · Organizer recommendation · what it blocks.

---

## Q-01 — Git history scrub vs rotate-only (leaked DB credential)

- **Context:** the Supabase Postgres URL in `.gitignore:46` is in pushed git history (audit C-1). Rotating the password neutralizes it; rewriting history on a repo with open branches/PRs has real costs.
- **Options:** (a) rotate now, no scrub, document as compromised-and-rotated; (b) rotate + full history rewrite.
- **Recommendation:** (a) — rotate now, no scrub, document. The credential is dead after rotation; a rewrite risks the home-redesign branch and open PRs for no additional security once rotated.
- **Blocks:** only the history-scrub sub-step of P0-001. Rotation proceeds regardless.

## Q-02 — Lifecycle thresholds sign-off

- **Context:** `lifecycle.ts` (active <180d, at_risk 180–365, lapsed >365) is finished and deliberately unwired pending founder approval; win-back has no fuel until it runs (audit doc 11).
- **Options:** approve as-is; adjust thresholds; per-shop configurable later.
- **Recommendation:** approve 180/365 as-is; make configurable only if pilots ask.
- **Blocks:** lifecycle wiring in E03; the marketed win-back capability.

## Q-03 — Direct customer creation: deliberate or omission?

- **Context:** there is no "Add customer" form anywhere; customers exist only implicitly via leads/inbound/import (audit trace A).
- **Options:** keep implicit-only; add a direct create form.
- **Recommendation:** build direct create/edit in E03 — D-002 (works without AI) effectively requires it.
- **Blocks:** E03 ticket cutting for CRM basics.

## Q-04 — Expired-quote visitor UX

- **Context:** P0-009 enforces `valid_until` server-side (done 2026-08-26); what does a visitor to an expired `/q/[token]` see beyond the minimal honest state?
- **Options:** dead end; "this quote expired — ask for a fresh quote" CTA that stages a lead/notification.
- **Recommendation:** the CTA — it converts an expiry into a lead instead of a dead end.
- **Blocks:** ~~final copy/behavior in P0-009~~ — P0-009 shipped **2026-08-26 (PR #25)** with the minimal honest expired state, exactly as planned. Q-04 remains open and now gates only the richer re-quote CTA (an expiry-to-lead conversion surface — no ticket exists for it yet; the Organizer cuts one when the decision lands).

## Q-05 — Operator quick-reply vs STOP

- **Context:** `sendOperatorSms` (owner's manual quick reply) skips send-policy; an owner can text an opted-out customer unrestricted (audit trace F).
- **Options:** unrestricted (today); warn-but-allow; hard-block.
- **Recommendation:** warn-but-allow — a human owner replying is not automated marketing, but the TCPA-adjacent risk deserves a visible warning.
- **Blocks:** E07 composer design; a small pre-E07 fix could ride P0-010 if approved early.

## Q-06 — Eval budget and cadence (locked principle #6)

- **Context:** live-model evals (Tier 2/3) gate nothing today; a drafter prompt regression ships on green CI (audit doc 07).
- **Options:** nightly scheduled run; on-prompt-change CI path filter; both.
- **Recommendation:** both — nightly `npm run eval` with failure notification, plus a CI path filter requiring the live tier when prompt files change.
- **Blocks:** the eval-gating ticket in E01 scope (P0-002 covers deterministic CI only).

## Q-07 — Slack approvals: future or delete?

- **Context:** D-026 locks Slack approvals disabled unless tenant authorization is rebuilt (C-2). Is the surface ever coming back?
- **Options:** keep dormant behind the flag; delete the surface.
- **Recommendation:** keep dormant through P1; delete in E10 cleanup if still unused. Revisit after E01 lands shop-bound claims.
- **Blocks:** nothing now (D-026 governs); affects E10 scope.

## Q-08 — Alert destination

- **Context:** monitoring anomalies, reconciliation drift, and cron failures alert to console only (audit doc 10: observability 4/10). P0-012 builds the delivery seam.
- **Options:** founder Slack channel; SMS; email; combination.
- **Recommendation:** founder Slack ops channel for everything + SMS for SEV-0/1 (per `../runbooks/incident-severity.md`).
- **Blocks:** P0-012 final destination config only (the seam builds now).

## Q-09 — Microsoft calendar priority within E02

- **Context:** D-014 makes Google AND Microsoft synchronized integrations; Google exists via Aurinko, Microsoft is net-new (Aurinko is believed to support it — **requires verification** per the `vendors/registry.md` rule; verify before E02 ticket cutting).
- **Options:** ship E02 with Google-only sync + Microsoft fast-follow; hold E02 exit for both.
- **Recommendation:** Google-first, Microsoft fast-follow — D-013 (native source of truth) is the hard part and doesn't depend on which mirrors exist.
- **Blocks:** E02 exit-criterion wording and ticket cutting.

## Q-10 — Archival approval

- **Context:** `../16-document-source-map.md` §Archival recommends banner-marking historical/superseded docs and moving run logs to `platform/docs/runs/` or `_archive/`.
- **Options:** approve the list as-is; edit the list; defer.
- **Recommendation:** approve after home-redesign merges (several TEMPORARY docs are still referenced until then).
- **Blocks:** the archival sweep (explicitly NOT performed in the Organizer's creation session).

## Q-11 — High-ticket approval threshold (D-021)

- **Context:** D-021 extends the ALWAYS_HITL floor to "high-ticket" actions; the dollar threshold is undefined.
- **Options:** fixed platform default; owner-configurable with a platform floor.
- **Recommendation:** $500 default, owner-configurable upward only (never below the floor), enforced in `isAutonomyAllowed()` and locked by tests like the existing floors.
- **Blocks:** the E01/E05-era ticket that implements the extended floor.

## Q-12 — Product-analytics storage/pipeline

- **Context:** `../14-product-analytics.md` defines the canonical event set; nothing is instrumented and no pipeline is chosen.
- **Options:** Postgres events table (own DB, RLS-scoped, zero new vendors); a hosted product-analytics vendor; both (table now, vendor later).
- **Recommendation:** own-DB events table first — consistent with the ledger-derived culture and zero new data processors before GDPR-shaped work (P10).
- **Blocks:** analytics instrumentation tickets (P1+).

## Q-13 — Trial length and variable-cost allowances (D-005)

- **Context:** D-005 approves a full operational trial with controlled variable-cost allowances; the numbers are unset. GRADIA_PRICING's "free = explore only" paywall text needs a trial amendment (contradiction C-04). **Amended 2026-07-27:** D-032 fixes that the trial starts after *meaningful setup or activation*, not email signup — the definition of that activation gate (which onboarding steps count: e.g. import committed, service menu saved, calendar connected, first simulated workflow run) is now part of this decision. Allowance numbers must also be re-derived against D-031 three-tier pricing (Q-22), not the $20/$29 model.
- **Options:** founder sets length + allowances + the activation-gate step list.
- **Recommendation:** 14-day clock starting at activation (gate = import committed OR service menu + calendar connected, per D-032) · allowances sized under Q-22 tier economics · existing fail-closed machinery enforces; card-optional at start, card required to convert.
- **Blocks:** trial build in E01/billing; GRADIA_PRICING amendment; `ui/flows/trial-to-paid.md` final states.

## Q-14 — RESOLVED 2026-07-27 → D-033

Marketing category language: resolved by the founder master product definition — OS category + "Run your shop. Capture every lead. Recover more revenue." headline adopted. Recorded as **D-033** in `11-decision-log.md`; C-01 updated. Per-feature claims still pass D-028/WHAT_GRADIA_DOES discipline. (Entry retained as a tombstone to preserve Q-numbering.)

## Q-15 — Calendar sidebar destination: ratify or revert (REFRAMED 2026-07-27)

- **Context:** **Correction — the original framing was factually stale.** Calendar has *already shipped* as a seventh sidebar destination (commit `3a06340`, `app-sidebar.tsx`); the live sidebar has seven destinations, not six. BUILD_REFERENCE §2 ("Sidebar exactly" six) and the planning docs were behind the code — layer-1 rule means the shipped seven is the current truth (contradiction C-15 in `../16-document-source-map.md`). The question is no longer "promote?" but "ratify or revert."
- **Options:** (a) ratify the shipped Calendar destination and amend BUILD_REFERENCE §2; (b) revert the nav change.
- **Recommendation:** (a) ratify — a scheduling product hiding its calendar is untenable, and E02/D-013 make it central. Founder sign-off needed because it amends BUILD_REFERENCE §2.
- **Blocks:** BUILD_REFERENCE §2 amendment; E02 IA ticket cutting; nothing in P0/P1. Related: Q-23 (target IA).

## Q-16 — Reports placement

- **Context:** E08 adds funnel/campaign analytics and exports; proposal is a Reports view under **Numbers & Billing** (no new destination). See `../06-ui-information-architecture.md`.
- **Options:** under Numbers & Billing; an eighth destination.
- **Recommendation:** under Numbers & Billing until real usage outgrows it.
- **Blocks:** E08 IA only.

## Q-17 — Role taxonomy for members (E01)

- **Context:** E01 introduces members/roles/invitations (D-018); the role set and what each role sees (e.g. techs limited to assigned-job threads, export/import permissions) is undefined. Referenced by E01/E04/E07.
- **Options:** minimal owner/member; owner/admin/tech; fully custom roles.
- **Recommendation:** owner/admin/tech — smallest set that covers a real shop; custom roles deferred.
- **Blocks:** E01 schema + permission matrix; E04 visibility rules; E07 composer role checks.

## Q-18 — Platform fee on Stripe Connect payments (E05)

- **Context:** D-019 approves Stripe Connect for customer payments; whether Gradia takes an application fee on shop transactions (and how that squares with the pricing doc's margin rules) is undecided.
- **Options:** no platform fee (subscription-only revenue); small application fee; fee only above a volume tier.
- **Recommendation:** no platform fee at E05 launch — keep the "$20 promise fully true" spirit; revisit with real volume data.
- **Blocks:** E05 billing design and pricing-doc amendment.

## Q-19 — Housecall Pro: import-only, dormant, or removed?

- **Context:** HCP is **quarantined** (D-030): every endpoint shape carries `TODO(verify)` (audit doc 08/13), the flag is off, it is not marketed, and no current workflow depends on it. Ticket `P3-001-housecallpro-dependency-review.md` produces the dependency inventory this decision needs.
- **Options:** (a) import-only source; (b) remain a disabled optional connector; (c) remove after dependency review.
- **Recommendation:** *import-only or remove unless a paying customer requires ongoing synchronization.* Do not maintain it as a core bidirectional integration without customer demand.
- **Blocks:** P3-001 outcome handling; any HCP marketing (stays off regardless).

## Q-20 — Jobber: keep as migration/temporary-sync connector after parity?

- **Context:** Jobber is **optional** (D-030): one-way best-effort push behind `crm-provider.ts`, feature-flagged, useful for migration and temporary synchronization while Gradia reaches CRM parity (E03).
- **Options:** keep optional/demand-driven; deepen to bidirectional sync; sunset after parity.
- **Recommendation:** *keep optional and customer-demand driven; never make it a core dependency.* Re-evaluate ongoing synchronization after Gradia reaches operational parity (post-E03).
- **Blocks:** E03 import-wizard scope for Jobber-sourced migration; nothing in P0.

## Q-21 — Direct Google Calendar / Microsoft Graph vs Aurinko

- **Context:** Aurinko is **transitional** (D-030): kept through stabilization; Gradia's DB becomes the appointment source of truth (D-013); Google + Microsoft capabilities are specified independently in `../vendors/planned-evaluations/` so `CalendarProvider` (D-029/ADR-002) is not shaped by Aurinko. Related: Q-09 (Microsoft priority *within* E02 assumes Aurinko as the adapter).
- **Options:** direct provider integrations during E02; after E02 stabilizes; never (stay on Aurinko).
- **Recommendation:** *keep Aurinko through stabilization and native-calendar development; evaluate direct providers after the Gradia-native appointment system and `CalendarProvider` interface are stable* (post-E02).
- **Blocks:** nothing now; a planned-evaluations decision post-E02.

## Q-22 — Three-tier pricing implementation (D-031)

- **Context:** D-031 (founder master definition, 2026-07-27) re-bases public pricing to Core $99 / Pro $149 / Operator $249. Everything downstream is unset: the docs' margin floors, credit menu, and $49-full-stack framing (`../15-cost-and-margin-model.md`) are derived from the superseded $20/$29 model, live Stripe products still bill $20/$29, and the trial allowances (Q-13) were sized against the old model. Contradiction C-14.
- **Options (founder sets each):** (1) tier feature split — what Core vs Pro vs Operator each include (voice, autonomy, seats, locations, allowances); (2) included credit/minute allowances per tier + re-derived margin floors (keep the ~3.3×-wholesale / ≥~67%-margin rules or re-set them); (3) adoption timing — before alpha (2026-08-07), at alpha, or post-alpha relaunch; (4) existing pilot/shop migration — grandfather, migrate with notice, or none exist to migrate.
- **Recommendation:** decide the tier split and allowances before any marketing pricing page or trial build; do not touch live billing during P0. Rewrite `_docs/GRADIA_PRICING.md` (founder-owned, outside gradia-v2) as the implementation act; `15-cost-and-margin-model.md` then re-derives floors.
- **Blocks:** marketing-site pricing page; trial-allowance numbers (Q-13); Stripe Billing product setup; `15-cost-and-margin-model.md` re-derivation; Q-18 framing ("the $20 promise" language is now stale); **P0-013 — Production billing model alignment** (the implementation ticket for this decision, cut 2026-08-28 at the P0-010 close as draft — decision-gated; `../tickets/P0-013-production-billing-model-alignment.md`).
- **Update 2026-08-28 (P0-010 close):** the production env exception is now on record — `STRIPE_PRICE_ID` / `STRIPE_PRICE_VOICE_ADDON` / `STRIPE_PRICE_CREDIT_PACK` / `STRIPE_PRICE_MINUTE_PACK` are intentionally **absent from Vercel Production**, and the P0-010 founder acceptance proved subscription/pack checkout fails closed **before any Stripe API call** with no charge and no local state change. That absence is the standing safety guard: nobody instructs setting those variables until P0-013 is implemented, reviewed, accepted, and ready for Production. **P0-013 is launch-blocking before live paid billing activation**; P0-011/P0-012 proceed independently of it.

## Q-23 — Target navigation IA vs founder 9-item recommendation

- **Context:** The founder master definition recommends: **Home · Inbox · Calendar · Customers · Sales · Jobs · Gradia · Reports · Settings**. Current shipped IA is 7 destinations + 2 pinned (Home · Approvals · Activity · Conversations · Customers · Calendar · Receptionist — pinned: Numbers & Billing · Settings), declared "final" in BUILD_REFERENCE §2 / `../06-ui-information-architecture.md`. Per-item deltas: Inbox would consolidate Approvals+Conversations+Activity; **Sales** (leads/quotes) and **Jobs** have no destination (Jobs was referenced in `../ui/navigation-model.md` as "a decision-queue item" that never existed — this entry is it); **Gradia** (agent/Opportunity-Engine surface) has no destination; Reports is Q-16; Calendar is Q-15.
- **Options:** (a) keep the current IA through alpha and converge toward the 9-item model as the domains land (Sales at E03, Jobs at E04, Reports at E08, Gradia at E09), each promotion a BUILD_REFERENCE amendment; (b) adopt the 9-item IA as the target now and rename/consolidate at a named phase; (c) keep the current IA permanently and reject the 9-item model.
- **Recommendation:** (a) — the 9-item nav describes destinations for domains that do not exist yet; promoting them now would create empty surfaces (violates written-empty-state and no-dead-controls rules). Record the 9-item model as the *target* IA in `../06-ui-information-architecture.md`, converge per-phase.
- **Blocks:** E03/E04/E08/E09 IA ticket cutting; BUILD_REFERENCE §2 amendments; nothing in P0/P1.

## Q-24 — Membership auto-renewal vs the money-HITL floor (E06)

- **Context:** Locked principle #4 / D-021: money writes are always HITL — "no mode, flag, or refactor bypasses this." E06 memberships require recurring billing: charging a renewal every month cannot practically wait for a human click per charge. E06's draft treats "owner approves the series once; code executes each renewal" as a documented exception locked by a future ADR — but reinterpreting the floor is a **founder** decision, not an ADR mechanism choice.
- **Options:** (a) series-level consent: the owner (and the end customer, via Stripe mandate) approves the membership once; each renewal executes deterministically with full audit + failure-to-HITL escalation; (b) per-renewal approval (defeats the product); (c) no membership auto-billing (defeats E06).
- **Recommendation:** (a) — consent-at-enrollment is the industry-standard recurring-billing model and preserves the floor's intent (no *AI-initiated* money movement without approval; renewals are owner-configured schedule execution, not agent discretion). On founder approval, record as D-03x and write the mechanism ADR before E06 build.
- **Blocks:** E06 membership-billing ticket cutting (P6); nothing earlier.

## Q-25 — Alpha date vs P0 exit gate

- **Context:** The 2026-08-07 alpha requires **all 12 P0 tickets done** plus an audit re-score (≥7 security/reliability). Sprint 1 started 2026-07-25 with max-2 WIP and serialized chains (P0-002→003→004; 005→006/007). Twelve reviewed tickets in ~13 days at that cadence is not plausible. No document states what happens if P0 misses the date — discovering this on 08-06 would force an unplanned choice.
- **Options:** (a) move alpha to when P0 completes (date follows the gate); (b) split the gate — define an "alpha-minimum" P0 subset (e.g. P0-001/002/003/004/005/010) and let the rest land during alpha; (c) raise WIP limits for P0 only (weakens the operating pattern).
- **Recommendation:** (a) or (b) — never (c). If (b), the founder names the subset; the exit criterion in `../10-roadmap.md` and `program/release-calendar.md` then records both gates explicitly.
- **Blocks:** release-calendar credibility; Sprint-2 planning; alpha go/no-go procedure.
