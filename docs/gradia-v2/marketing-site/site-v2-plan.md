# Marketing Site v2 — Plan

_Created 2026-08-28 (Claude, with founder decisions given same day; restored + amended same day after an uncommitted-work wipe — now committed). Lives in `gradia-v2/marketing-site/` per the Organizer layer. Supersedes the external ChatGPT website brief as the working plan for trygradia.com v2. On any conflict, precedence follows `../16-document-source-map.md`: audited behavior → decision log → this plan._

## 0. Founder decisions encoded in this plan (2026-08-28)

1. **Headline/category: D-033 stands.** Category "The operating system for detailing and automotive appearance shops." Headline "Run your shop. Capture every lead. Recover more revenue." The ChatGPT hero ("Your detailing business. Connected.") is retired; "connected" language in supporting copy only.
2. **Q-22/Q-13 RESOLVED — D-034/D-035.** Pricing page content is unblocked (tier contents + trial model decided); it ships gated on **P0-013** (live billing migration) so the site never advertises prices checkout can't charge.
3. **Customer Recovery section and Meta Ads teaser are CUT from the homepage.** Drafted in §9 (BLOCKED appendix) with unblock conditions.
4. **This folder is the plan of record.** `marketing/` briefs point here. **Visual reference: trygtm.com — see `reference-trygtm.md` (2026-08-28).**

## 1. Binding constraints (read before building anything)

- **Claim discipline:** every public claim passes `_docs/WHAT_GRADIA_DOES.md` gates + D-028 (live/beta/planned always distinguished). ✅ That doc was rewritten 2026-08-28 to D-033/D-034 (old version at `_docs/.archive-2026-08-28/`).
- **Real UI only** (D-025 extended): no fake dashboards, metrics, testimonials, or logos. Product visuals are compositions of actual Gradia screens with clearly-fictional sample records (Sarah Mitchell · 2024 BMW X5).
- **Show standard operations working independently of AI** (D-002/D-033).
- **Approval/control is the differentiator:** "Gradia recommends the next action. You decide what happens." Never market autonomy without the trust-dial framing; money + calendar always ask.
- **No founding pricing, lifetime discounts, or fake crossed-out prices** (D-003/D-031).
- **Voice receptionist: feature, never headline** — not publicly marketable until the live telephony acceptance run passes (capability #20: internal). See §9.3.
- **Trial copy (D-032/D-035):** "14-day guided trial · starts after your setup · trial usage limits apply" is claimable. Never "try everything free/unlimited."

## 2. Route map and gating

| Route | Required by | Status in this plan |
|---|---|---|
| Home | D-033 | Build in Pass 2–4 (spec in §3) |
| Product | D-033 | Pass 5 — deep dive; alternating real-UI panels; comparison table ("six tools vs Gradia", per reference-trygtm §ADOPT-8) |
| Receptionist | D-033 | Pass 5 — **build-ready, publish-gated** on telephony acceptance run (§9.3) |
| Industries ×5 (Detailing · Ceramic coating · PPF/tint/wrap · Mobile detailing · Fleet) | D-033 | Pass 5 — shared template, industry-specific sample data |
| Pricing | D-033, D-004 | Content unblocked (D-034/D-035). Build in Pass 5; **publish gated on P0-013** |
| Security | D-033 | Pass 5 — only audited/true posture (`../08-security-and-reliability.md`) |
| Demo | D-033 | Pass 5 — the four demo assets from WHAT_GRADIA_DOES §7, as they become claimable |
| Login | D-033 | Exists (`/portal`) — later routes to app subdomain |
| Resources | not required | Keep; absorbs the SEO plan (§6). Not a launch blocker |

Nav: `Product · Receptionist · Industries · Pricing · Resources` + `Sign in / Start your trial`. Security + Demo in footer until content matures.

## 3. Homepage — 10 sections, one story

Story spine: *scattered shop → one operating system → you stay in control → start.* Every section: headline → ≤2 sentences → real product visual. No section may introduce a claim whose matrix row (§4) isn't ✅ or labeled beta. **Hero is centered** (chip eyebrow · headline · ≤3 support lines · ink pill CTA + underlined-text secondary · dark graphite product frame below) per `reference-trygtm.md`.

1. **Hero.** Chip eyebrow: BUILT FOR DETAILING & AUTOMOTIVE APPEARANCE SHOPS. H1: "Run your shop. Capture every lead. Recover more revenue." Support: "Gradia connects your customers, vehicles, leads, quotes, jobs, conversations and schedule in one operating system — and helps keep the work moving." CTAs: **Start your trial** (ink pill) / See how it works (underlined text). Trust line: "Guided setup · You approve what goes out." Below: dark product frame — one lead entering Gradia → staged → approved → scheduled (real UI frames).
2. **Problem.** "Running a shop shouldn't take six disconnected systems." Scattered calls/texts/DMs/notes/calendars consolidating into one Gradia surface. Three pains max: leads get lost · follow-up depends on memory · the owner is the system.
3. **Connected flow.** "One system from first message to finished job." Capture → Understand → Prepare → **Approve** → Schedule → Retain; the same customer (Sarah Mitchell · 2024 BMW X5) persists through every stage — one concrete example carries the section (trygtm technique).
4. **Operations dashboard.** "Know what needs attention before it becomes a problem." Real Home dashboard UI in a graphite frame: needs-attention, today's jobs, open quotes, recommended actions. "Your business, prioritized for you."
5. **Core operating system.** "Everything stays connected." Four alternating full-width panels: Customers & Vehicles · Leads & Pipeline · Quotes, Jobs & Scheduling · Conversations. One headline, one sentence, one real screen each.
6. **Gradia Agent + control (one section).** "Tell Gradia what needs to get done. Approve it before it goes out." Demo: "Show me every ceramic coating lead this month that hasn't booked" → list → "Prepare follow-ups" → **Prepared → Review → Edit → Approve** → activity log. "Start with approvals. Money and calendar always ask."
7. **Receptionist.** "Don't lose the customer because you're under a car." **Publish-gated** — built behind a flag, hidden until claimable (§9.3).
8. **Industries.** "Built to grow with your shop." Four tiles → five industry pages.
9. **FAQ — honest answers** (added 2026-08-28, trygtm reference). 5–7 direct answers, unflattering included ("Does Gradia send messages by itself? Only if you turn autonomy on — and money and calendar always ask."). Feeds FAQPage JSON-LD in Pass 5/6.
10. **Final CTA.** "Run the shop without the shop running you." + trust line incl. "Import your existing customers — no starting over."

**Deliberately absent:** credibility/logo strips, Customer Recovery (§9.4), Meta teaser (§9.5), pricing numbers/tier names (until P0-013), testimonials, metrics, stock imagery.

## 4. Claims matrix (seed — becomes `claims-matrix.md`)

| Homepage claim | Status | Evidence |
|---|---|---|
| One CRM: customers, vehicles, quotes, jobs, conversations | ✅ live | capability map #5–#8, #10, #15 (pilot) |
| Leads & pipeline board | ✅ live (pilot) | #7 |
| Gradia Agent: ask → staged actions → approve | ✅ live (pilot) | #18; WHAT_GRADIA_DOES §4 |
| Whisper: speak → staged work | ✅ live | §4 |
| Approve-first; money+calendar always ask | ✅ live | guarantee #1 |
| Follow-ups + campaigns by SMS/email, approve-first | ✅ live | §4 |
| Import existing customers/calendar | ⚠ beta — label it | #16 internal; D-006 |
| Home/operations dashboard | ⚠ verify build state before screenshotting | #17 building |
| Calendar/scheduling | ⚠ building/designed — current real UI only | #9 |
| Voice receptionist answers/quotes/books | ⛔ until acceptance run | #20 internal |
| Customer recovery / opportunity engine | ⛔ designed only | #19 |
| Meta lead ads integration | ⛔ not in capability map | — |
| Prices/tier contents on site | ⛔ until P0-013 | D-034, C-14 |

## 5. Design + copy rules

> **Founder-designated visual reference: trygtm.com — `reference-trygtm.md`** (adopt / do-not-copy). Net: centered hero, chip eyebrow, **ink-pill primary CTA**, underlined-text secondary, **monochrome-dominant** (violet = signal color only: links, focus, approval highlights), dark graphite product frames on the light page, honest FAQ.

Premium, quiet, product-first (Stripe/Linear discipline): one typeface (Inter), systemic scale; neutrals + one accent used for meaning; hairline borders over shadows; all six interactive states designed, custom focus rings; consistent motion curves/durations, motion only where it explains, `prefers-reduced-motion` respected; designed empty/loading states. Banned: neon/purple AI styling, glassmorphism, stock robots, floating context-free cards, fake metrics, feature-card graveyards, walls of copy, dev/AI jargon. A11y + perf are gates: semantic HTML, keyboard nav, contrast, focus states; no video backgrounds or always-running animation.

## 6. Build passes (one ticket = one branch; marketing repo, branch `site-v2`)

- **Pass 0 — truth docs: ✅ COMPLETE 2026-08-28** (WHAT_GRADIA_DOES + GRADIA_PRICING rewritten; stale docs bannered). Remaining: formalize `claims-matrix.md` in Pass 1.
- **Pass 1 — foundation: ✅ COMPLETE 2026-08-28** (tokens, primitives, nav, footer, `/v2` style guide; trygtm amendments applied). Hidden-page fate: healthcare-flavored resources retired; SEO-valuable routes re-target into v2 IA; `NEXT_TASK.md` SEO Phase-1 rides Pass 5/6.
- **Pass 2 — homepage** structure + copy (Claude Code, per `marketing/NEXT_TASK.md`; placeholders allowed).
- **Pass 3 — product visuals:** real-UI compositions, verified against current app state.
- **Pass 4 — motion** (hero sequence, connected flow, approval flip only).
- **Pass 5 — subpages** (Product, Industries ×5, Security, Demo, Resources, Pricing-behind-gate; Receptionist flag-hidden).
- **Pass 6 — conversion** (CTA paths, trial messaging, signup flow, JSON-LD).
- **Pass 7 — QA (Cursor, independent):** design consistency, responsive, a11y, perf, links, copy-vs-claims-matrix audit.
- **Cutover:** built on `site-v2` with Vercel previews; waitlist stays live until founder-approved merge. Cutover = swap homepage + lift takedown middleware for launched routes + sitemap + 301s. Pricing route enters only when P0-013 is done.

## 7. Open founder actions

1. ~~Q-22~~ RESOLVED 2026-08-28 (D-034). Remaining: **P0-013** before pricing publishes / billing goes live.
2. ~~Q-13~~ RESOLVED 2026-08-28 (D-035).
3. ~~Truth-doc rewrites~~ ✅ Done 2026-08-28.
4. **Telephony acceptance run** — unblocks Receptionist page + homepage section.
5. **Cutover approval** — when v2 replaces the waitlist site.
6. **app.trygradia.com DNS** for the platform app; then retire legacy `/portal`.

## 8. Rejected from the ChatGPT brief

14-section homepage (→10); credibility noun-strip; invented trial numbers (now set by D-035 instead); "Solutions" nav (D-033: Industries); dropped Security/Demo routes; "Your detailing business. Connected." hero; Meta teaser + Recovery section (gated below).

## 9. BLOCKED appendix — drafted, gated, do not ship

**9.1 Pricing page.** Three tiers $99/$149/$249 with contents per D-034, trial note per D-035, no crossed-out prices. **Remaining gate: P0-013 ready** (live billing still charges $20/$29; Stripe prod price IDs intentionally absent until P0-013 — do not "fix" that from the marketing side).

**9.2 Trial numbers.** RESOLVED (D-035): 14-day from activation, card-to-convert, 500 credits + 15 min. The one-line trial sentence in §1 is claimable now.

**9.3 Receptionist.** Honest framing when live: "Gradia captures, organizes and prepares the opportunity so your business can respond properly" — quote/book claims only as verified. **Unblock: telephony acceptance run passes; #20 flips from internal.**

**9.4 Customer Recovery.** "Your next jobs may already be in your customer list" — relevant, history-based follow-up, never bulk spam. **Unblock: Opportunity Engine (#19) reaches beta + WHAT_GRADIA_DOES adds it.**

**9.5 Meta Ads / lead nurturing teaser.** "Turn ad leads into conversations automatically," labeled COMING. **Unblock: Meta lead integration enters the decision queue + capability map with a phase.** Teasing a capability with no engineering existence is forbidden regardless of labeling.
