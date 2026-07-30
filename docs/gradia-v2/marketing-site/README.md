# Marketing Site

_Created 2026-07-25 by the Organizer. The marketing site lives in `~/Gradia/marketing/` (separate area — stay in lane); this folder holds its **planning** only._

## Category, headline and message (D-033 — founder master definition, 2026-07-27)

- **Category:** "The operating system for detailing and automotive appearance shops." (Resolves Q-14; C-01 updated. Supersedes the "CRM that works itself" *category* framing — `_docs/WHAT_GRADIA_DOES.md`'s headline line needs the founder's claim-list update; its per-feature claim gates remain binding.)
- **Primary headline:** "Run your shop. Capture every lead. Recover more revenue."
- **Supporting message:** "Gradia connects your CRM, scheduling, quotes, jobs, conversations and AI receptionist in one operating system built specifically for automotive appearance businesses."
- **Import reassurance:** "Import your existing customers, vehicles and calendar. No need to start over."
- **Control reassurance:** "Gradia recommends the next action. You decide what happens."

## Required routes (D-033)

Home · Product · Receptionist · Industries (with pages: Detailing · Ceramic coating · PPF/tint/wrap · Mobile detailing · Fleet) · Pricing · Security · Demo · Login.

## Binding claim discipline

- Every claim must pass `_docs/WHAT_GRADIA_DOES.md` (the claim list / "not yet claimable" gates) — D-028: live, beta and planned functionality are always distinguished. The site must **show standard operations working independently of AI** (D-002), explain approval controls, switching/imports, and the trial.
- **Show real product UI only** — no fake dashboards, fake metrics, fake testimonials or logos (D-025 extended to marketing); **no unsupported security claims** (the Security route states only what is audited/true).
- Pricing copy: full public pricing (D-004), **no founding pricing or lifetime discounts (D-003)**. **The pricing page is BLOCKED on Q-22** — D-031 re-based pricing to Core $99 / Pro $149 / Operator $249, but tier split/allowances/timing are unresolved and live billing still charges the old model (C-14). Pricing and feature-status values come from **centralized configuration shared with the app** (`pricing_config` / capability statuses per `../04-capability-map.md`), never duplicated into marketing files.
- Voice receptionist: feature, never headline; not marketable until the live telephony acceptance run passes.
- Historical waitlist docs (`_docs/waitlist-*.md`, `GRADIA_LAUNCH_GTM_PLAN.md`) are layer-7/8 — do not build copy from them.

## Planned contents

`claims-matrix.md` (claim · status live/beta/planned · source evidence), `pricing-page-spec.md` (BLOCKED on Q-22 + Q-13), per-industry page briefs (the five Industries routes), launch-page briefs per release.
