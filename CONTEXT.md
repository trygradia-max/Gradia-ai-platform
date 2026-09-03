# GRADIA — CONTEXT

_Founder decision, 2026-09-03. **This file is the single source of truth for what Gradia is and what gets built next.** Any session — Claude Code, Cursor, or a new Cowork chat — reads this file first and needs nothing else to start work. The `docs/gradia-v2/` library remains the audit trail and the detail reference; it is no longer on the critical path of every session. Where this file and any other plan disagree, **this file wins.**_

---

## 1. What Gradia is

**Gradia is an AI-native CRM for automotive appearance shops** — detailing, ceramic coating, PPF, tint.

Every channel flows in: phone calls, SMS, email, website forms, and Meta lead ads. Google (Gmail + Calendar) connects. All of it lands in one CRM with customers, vehicles, leads, a pipeline, quotes, and a calendar.

**The Gradia Agent sits on top and operates it.** A new lead arrives; the agent qualifies it over SMS, answers questions, quotes, proposes times, books the appointment, and moves the card through the pipeline. The owner reads what happened and approves what matters. They do not operate the software — they supervise it.

**ICP:** established shops with staff (3–30 employees), already spending on ads. Not solo operators.

**The commercial claim:** Jobber and Urable are systems of record you operate. Gradia does the work and reports it.

## 2. What Gradia is NOT (D-067 — do not build, do not plan, do not claim)

Removed from scope entirely. Not "later" — out. Revisit only on a recorded founder decision after a paying customer asks.

- Jobs, work orders, checklists, team scheduling
- Invoices, deposits, payments, Stripe Connect, any payment processing
- Recurring jobs, memberships, fleet accounts
- Locations, bays, bookable resources
- B2B companies entity
- Mobile/PWA app
- Support tooling, funnel/campaign analytics suite
- Website building, social posting, photo-based quoting, Instagram/Facebook DMs

Gradia is **not** a payment processor and never will be (licensing, underwriting, reserves — permanently out of scope).

## 3. Status — what is actually true today

**Works, verified, in production:**
- CRM core: customer identity spine with dedupe, vehicles, 6-stage pipeline with timers, quotes with a public accept page, calendar with working hours
- HITL approval engine — atomic claim, edit-then-approve, undo, rollback-on-failure. The strongest subsystem in the codebase.
- Inbound SMS: signature-verified → identity → consent ledger → classify → staged lead + drafted reply
- Gradia Agent: planner → deterministic runtime, audience caps, cooldowns, consent gates, dry-run previews, 4-layer audit trail
- Shared brain: pgvector memory + knowledge + one persona + one pricing module feeding voice, quotes and drafts identically
- Billing/metering/reconciliation loop; fail-closed credits
- Gmail connection (fixed 2026-09-02)
- Performance: Home 81→43 queries/request, 2MB→338KB HTML, mobile Lighthouse 0.45→0.77 (shipped 2026-09-03)

**A2P STATUS — CONFIRMED 2026-09-03 (founder checked Twilio console):** **No A2P Brand. No A2P Campaign. Nothing registered.** SMS is therefore **not carrier-approved** — 10DLC traffic will be filtered or blocked. This is not a "verify later" item, it is a confirmed blocker. Consequences: **B-08d cannot be demoed until a Brand + Campaign are APPROVED**; the voice-first activation sequence (A-02a) is now forced, not optional; registration is calendar time and must start immediately. _Caveat to close: the console shown was account "Gradia Demo" — confirm it matches `TWILIO_ACCOUNT_SID` in Vercel production._

**Built but OFF or UNVERIFIED — do not claim, do not demo:**
- Voice receptionist — complete in code, **never verified on a real call**
- Calendar conflict enforcement — built, dormant behind `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` (OFF in production). **Double-booking is possible today.**
- A2P 10DLC registration SIDs — unverified live
- Three-tier billing — 80% written, uncommitted-to-main on branch `wip/p0-013`
- P0-001 credential remediation — password rotated 2026-07-29 (no live exposure), ticket never merged

**Missing for the definition in §1:**
- Meta lead ads intake
- Email sending / in-thread reply (read-only today)
- The new-lead → qualify → book flow wired as one automatic path
- CRM holes: no direct "add customer" form, no data export, no VIN field, dual-truth `leads.status` vs `stage`

## 4. Build list — in order, one ticket = one session

A session picks the **first unchecked item**, builds it, opens a PR, and stops. It does not start the next one.

- [ ] **B-01 — Data export.** Customers, vehicles, leads, appointments, conversations → CSV + JSON. Tenant-scoped, rate-limited. _Loop proof ticket: small, no money, no schema._
- [ ] **B-02 — Finish three-tier billing.** Complete the work on `wip/p0-013`. Founder acceptance required; Stripe live prices founder-only.
- [ ] **B-03 — Chief of Staff screen — REPLACES today's Home, does not add to it.** One hero line, one needs-you queue, one activity stream, one small KPI row. **Deletes the stacked legacy tail** (see §4d U-01) and **absorbs `/activity` and `/approvals`** as sections rather than separate destinations. Reads existing approvals/trust/conversation data. No new schema.
- [ ] **B-04 — Agent command bar. Smaller than it looks — it already exists.** `command-bar.tsx` is mounted app-wide in `(dashboard)/layout.tsx` as a lazy-loaded dialog around `BiChat`. The work is: surface it persistently on Chief of Staff, **bind ⌘K globally** (§4e U-09), give it write tools through the existing approval executor, and delete the duplicate `BiChat` mount on `/conversations` (§4d U-04). Plain-language asks over the shop's own data. Every write goes through the existing approval executor — no second execution path. Bulk/marketing sends are refused with an honest "not yet" (consent + marketing 10DLC required first).
- [ ] **B-05 — Lead intake seam.** One normalized entry point every source writes through: source, payload, dedupe, tenant binding, replay-safe. The spine — no new lead source ships outside it.
- [ ] **B-06 — Existing channels → intake seam.** Web form, inbound call, SMS, email.
- [ ] **B-07 — Meta Lead Ads → intake seam.** Signature-verified, replay-safe, per-shop page binding.
- [ ] **B-08 — Instant response.** New lead triggers an agent SMS within 60 seconds; qualifies; proposes times. SLA test-locked.
- [ ] **B-09 — Conflict enforcement ON.** Acceptance walk on a flag-on Preview, then flip in production.
- [ ] **B-10 — Book from the SMS conversation** into a real appointment. Closes the loop.
- [ ] **B-11 — CRM holes.** Direct add-customer form, VIN field, retire the `leads.status` enum.
- [ ] **B-15b — Collect A2P registration data during onboarding (founder's idea, adopted).** Capture everything the carrier needs while the shop is already filling in setup — legal business name, EIN/Tax ID, entity type, industry, website, business address, authorised contact — plus campaign fields: use case, sample messages, opt-in description and proof, and the HELP/STOP reply text. Submit to Twilio via API on completion; never send the shop to Twilio's site. Pairs with A-02b/c: registration starts on day one and the shop sees an honest pending state while voice and email already work.
- [ ] **B-16 — Onboarding that actually activates a shop.** Today it collects four things: shop name, location, phone, number. **Missing: services + pricing (the agent cannot quote without them), working hours, calendar connection, SMS consent language, Meta connection, A2P status.** A shop finishes setup today and the agent is mute. Highest-leverage ticket for activation. (§4f G-05)
- [ ] **B-12 — Inbox reply. SMS first, then email.** `conversation-threads.tsx` is **read-only** — replying to a customer text today means leaving the inbox, finding the customer record and using `SmsQuickReply` there. Inline reply on the thread is the fix; email send follows. (§4e U-07)
- [ ] **B-13 — Minimal CSV import.** Customers + vehicles, dedupe on phone/email.
- [ ] **B-14 — Navigation cut to five + Settings.** Chief of Staff · Inbox · Pipeline · Customers · Calendar, with Settings at the bottom. `/receptionist` and `/billing` (Numbers) move **into Settings** — they are setup surfaces, not daily-use screens. `/activity` and `/approvals` become Chief of Staff sections. Everything in §2 flag-hidden, not deleted. (§4d U-02, U-05)
- [ ] **B-15 — Design pass** (Cursor lane). Stripe-grade across the five screens.


## 4b. Adoption blockers — found 2026-09-03, not previously tracked

These are not features anyone asked for. They are the things that make the product unusable or unsellable if missing. Verified against the codebase, not assumed.

**Tier 1 — blocks a shop from using Gradia at all**

- [ ] **A-01 — Phone number continuity.** No porting or call-forwarding logic exists (grep: only a string match). An established shop will not change the number on its listing, trucks and signage. Need **conditional call forwarding** (fast path: shop forwards on no-answer to their Gradia number) and/or **Twilio number porting** (LOA, days-to-weeks). Without this the voice receptionist cannot be sold to the ICP. **Highest-value missing item in the product.**
- [ ] **A-02 — Per-shop A2P 10DLC onboarding.** `twilio-a2p.ts` has brand/campaign logic, but each shop needs its own registration: a fee plus days-to-weeks of approval before it can send one SMS. Founder must establish the real timeline and cost, then design what a shop *does* during the wait. If the answer is "nothing", they churn before activation.
- [ ] **A-03 — Owner notifications.** No push/web-push/notification infrastructure found. The approval queue only works if the owner knows something is waiting. Minimum: SMS or email on a pending approval + a daily digest. Small work, decisive for adoption.
- [ ] **A-04 — Self-serve services and pricing.** Confirm a shop can enter its own packages, durations and vehicle-size modifiers without founder help. If not, the agent cannot quote and the zero-founder-touch principle is broken.
- [ ] **A-05 — SMS consent capture at the form boundary.** The consent ledger exists; capture at lead-form intake does not. A Meta/web form that feeds an outbound agent text needs recorded prior express consent. Required consent language on connected forms + per-lead consent record. **Actual wording is a lawyer question, not an engineering one.**

**Tier 2 — blocks retention**

- [ ] **A-06 — Escalation / human handoff.** When the agent is out of depth it must stop, notify the owner, and tell the customer a human will follow up — never guess. One bad answer on a $3k PPF inquiry loses the shop money and loses the account.
- [ ] **A-07 — Chief of Staff usable one-handed on a phone.** The owner is not at a desk. Responsive is claimed; verify it on a real phone.
- [ ] **A-08 — Staff logins.** The ICP is shops with staff. Single-owner login is an enterprise blocker (this is the one item from the §2 cut list that will come back).
- [ ] **A-09 — Deposits.** Cut from scope, but detail shops use deposits to stop no-shows. Expect the objection; answer it honestly rather than building it.

**Tier 3 — blocks the business, not the product**

- [ ] **A-10 — Support channel.** No support tooling. A shop with a problem on Saturday morning needs somewhere to go.
- [ ] **A-11 — Terms of service, privacy policy, DPA.** Needed before signing a business customer. Counsel, not engineering.
- [ ] **A-12 — Backup and restore posture.** Know the Supabase RPO/RTO and have restore tested. Losing a shop's customer data ends the company.


## 4c. Second dig — 2026-09-03

**A2P strategy (answers A-02).** Voice requires **no** A2P registration — that is why Vapi can be switched on instantly. SMS cannot avoid it; carriers require the sending brand to be the actual business, and sharing one campaign across customer shops is a violation that risks the whole Twilio account. So the strategy is to remove the *wait* from the customer's experience, not the registration:

- [ ] **A-02a — Voice-first activation.** Day 1 a shop gets: voice receptionist, email, CRM, pipeline, calendar, Chief of Staff. SMS lights up when registration clears. The product must be worth paying for before SMS exists.
- [ ] **A-02b — Registration submitted by Gradia, not the shop.** Collect business info (EIN, address, contact, use case, sample messages) inside onboarding and submit via the Twilio API automatically. The shop never visits Twilio.
- [ ] **A-02c — Live status in-app.** A truthful "SMS pending carrier approval — voice and email are live" state, per D-025. Never a silent dead channel.
- [ ] **A-02d — Choose the tier per shop.** Sole Proprietor registration (fast, no EIN, low throughput cap) vs Standard/Low-Volume Standard (EIN required, more vetting, higher throughput). The ICP (3–30 staff) has EINs → Standard. Founder to confirm current fees and timelines in the Twilio console — they change.
- [ ] **A-02e — Evaluate toll-free verification as a bridge** for shops that need SMS before 10DLC clears. Different, often faster process; downside is a toll-free number reads as a call centre to a local customer.

_Framing: this friction is a moat, not just a tax. Every competitor faces it, and a shop that has completed registration inside Gradia is expensive to move._

**Additional findings**

- [ ] **A-13 — Jobber integration is unverified and still wired.** `jobber-push.ts`, `crm-provider.ts` and `mcp/server.ts` reference it and Settings shows a Jobber tile, but it is in the same "never verified live" category as the Housecall Pro connector that was deleted (D-052). **Decide: verify it or delete it.** A settings tile for an integration that may not work breaks the no-fake-anything rule.
- [ ] **A-14 — Settings has 13 sections** (Service menu, Working hours, Automations, Voice, Email, Payments, Jobber, Knowledge, Reviews, Usage, Developer, More, Plan and usage) for a product targeting five screens. Audit each: Reviews, Developer and "More" need a reason to exist or they go behind a flag.
- [ ] **A-15 — Onboarding is missing the steps that make the agent work.** Current flow: Your inbox · Your number · Meet your receptionist · Open the dashboard · Finish setup. **Absent: services and pricing setup** (the agent cannot quote without it), **SMS consent language**, **Meta connection**, and **any A2P status handling**. Onboarding is where activation is won or lost.
- [ ] **A-16 — ~10 real dashboard screens vs the 5-screen target** (dashboard, activity, approvals, conversations, customers, calendar, receptionist, settings, plus detail routes). Feeds B-14. _Note: `/agent`, `/agents`, `/leads`, `/recovery`, `/schedule`, `/chat` are clean redirects to canonical routes — good hygiene, not clutter._

_Positive finding: **zero TODO/FIXME comments in ~67k lines.** Unusual discipline; the codebase is not the problem._


## 4d. Interface audit — 2026-09-03

Read from the code, not from the design docs. These are the reasons the app feels dated and hard to use. **Solutions are folded into B-03, B-04 and B-14 above — these are the findings behind those tickets.**

- [ ] **U-01 — Home renders 14 stacked components; it is two designs on top of each other.** `dashboard/page.tsx` mounts WelcomeModal · DashboardHero · WhisperSuggestionQueue · RoiReceipt · KpiRow · BookedToday · TodayMoneyRows · CrmCleanupCard · HomeFeed · RevenueTiles · WhisperButton · AiLeadSection · LiveLeadFeed · ChannelConnectionCard. That is **four separate numbers surfaces** (KpiRow, RevenueTiles, RoiReceipt, TodayMoneyRows), **three separate feeds** (HomeFeed, LiveLeadFeed, WhisperSuggestionQueue) and **three ways to create or act** (AddLeadDialog, WhisperButton, AiLeadSection). This is the documented, still-open contradiction C-08 — the home redesign added the new surface without removing the legacy tail. **Solution:** B-03 replaces this page outright — one hero, one needs-you queue, one stream, one KPI row. Everything else is deleted or moved to the screen it belongs to. _This single ticket is most of why the app "looks outdated."_
- [ ] **U-02 — `/customers` is three products on one route.** It mounts PipelineBoard + CustomersTable + QuotesList + CrmCleanupCard. The sales pipeline, the customer database, and the quote list share one page under a nav label that mentions none of them. A user looking for their pipeline will not find it. **Solution:** Pipeline becomes its own nav destination (it is a core screen per §1); Customers is the table; quotes live inside the customer/lead record, not as a top-level list.
- [ ] **U-03 — Three inboxes and no "start here."** Nav offers Approvals, Activity and Conversations; Home carries three more feeds. Six surfaces show "recent things" and nothing tells the owner which one is today's job. This is the core usability failure of the product. **Solution:** Chief of Staff is the single answer to "what do I do now"; Conversations is the message threads; Approvals and Activity stop being destinations.
- [ ] **U-04 — `Ask Gradia` (BiChat) is bolted onto the Conversations page.** Asking the AI a business question sits beside reading customer SMS threads. Two unrelated jobs, one screen. **Solution:** BiChat becomes the Chief of Staff command bar (B-04); Conversations becomes purely the unified inbox.
- [ ] **U-05 — Nav is 9 items for a 5-screen product**, and `Numbers & Billing` pairs a setup task (buying a number) with an account task (paying Gradia). `Receptionist` is a build-time configuration surface sitting in daily navigation. **Solution:** see B-14.
- [ ] **U-06 — `CrmCleanupCard` renders on both Home and Customers.** Duplicate surface, and its loader (`getCrmCleanupState`) reads every customer and vehicle on each Home render — a known PERF-001 residual. **Solution:** one home for it (Customers), removed from Home by B-03.


## 4e. Interface audit, round 2 — 2026-09-03

- [ ] **U-07 — The unified inbox cannot reply. This is the worst flow in the product.** `conversation-threads.tsx` (107 lines) has no composer — no textarea, no submit, no send. `SmsQuickReply` exists only on the **customer detail page**. So answering a customer text means: leave Conversations → find the customer → reply there → navigate back. Every comparable product (Front, Missive, Intercom) replies inline in the thread. **Solution:** B-12, SMS reply first.
- [ ] **U-08 — Detail records are full-page navigations, not side panels.** `components/ui/sheet.tsx` exists and is barely used. Clicking a customer from the pipeline board loses the board. Modern CRMs (Attio, Linear) open the record in a side panel so the list keeps its place and scroll position. **Solution:** open customer/lead/approval detail in a `Sheet` from list surfaces; keep the full page as a direct-link fallback.
- [ ] **U-09 — No ⌘K.** The command bar is mounted app-wide but no keyboard binding was found. For a product whose pitch is "ask it and it does the work," the ask should be one keystroke from anywhere. Every tool in this category has it. **Solution:** folded into B-04.
- [ ] **U-10 — Agentic UX principle to build against: chat-first fails.** Current practice is that agent work belongs in the surface where the work lives — reviewable action cards in context, with chat as an escape hatch, not the primary interface. This validates Chief of Staff as the main screen and is an explicit warning **not** to let the command bar become the product. Cards first, chat second.
- [ ] **U-11 — Correction: the visual system is NOT outdated.** 160 design tokens in `globals.css` and Geist as the type family — current, and in the same family as the references. The "old and outdated" feeling comes from **density and structure** (14 components on Home, 6 places showing recent activity, no reply in the inbox), not from typography or color. **Do not spend a session restyling.** Fix the structure (B-03, B-12, B-14) and the app will read as modern with the existing tokens.


## 4f. Agent + flow audit — 2026-09-03

**Verdict: the Gradia Agent is agentic on phone calls and advisory everywhere else.** That is a real product, but it is not the product described in §1. Four specific gaps, all fixed by B-08a–d:

- [ ] **G-01 — Lead creation emits no event; the agent is welded to the SMS webhook.** `quickCreateLead` / `createLead` fire nothing. Only leads arriving as an inbound text get worked. **This is the single biggest gap between the code and the vision.** → B-08a.
- [ ] **G-02 — SMS is a drafter, not a conversation.** `sms-drafter.ts` (368 lines) holds no conversation state — one classify, one drafted reply, then approval. Voice has a genuine multi-turn loop with 8 tools; SMS does not. → B-08b.
- [ ] **G-03 — No agent can move a lead through the pipeline.** Grep across `owner-agent.ts`, `vapi-tools.ts` and `agent-runtime.ts` found no stage-move tool. The claim "the agent manages the pipeline" is false today. → B-08c.
- [ ] **G-04 — The owner agent's seven tools all stop short of completing anything:** `add_note`, `create_lead`, `draft_reply`, `preview_outreach`, `propose_booking`, `stage_outreach`, `update_customer`. Every one is create/draft/propose/stage. Correct for money and calendar (D-021 floor) — wrong as the *whole* toolset. The agent needs completing tools for non-floor actions, still routed through the approval executor.

**What works, do not rebuild:** the voice agent's 8-tool loop is the reference implementation. B-08b should mirror it, not invent a second pattern.

**Flow findings**

- [ ] **G-05 — Onboarding collects four fields.** Step ids found: `shop-name`, `shop-location`, `shop-phone`, `number`. **Absent: services and pricing, working hours, calendar connect, SMS consent, Meta connect, A2P status.** A shop completes setup and the agent has nothing to quote from. → B-16.
- [ ] **G-06 — Calendar is week-view only** and booking still writes Aurinko event ids (`approvals.ts` ~916). The external-calendar coupling the audit called the top operational risk is unchanged. Month view and a native-first booking path are follow-ups; **conflict enforcement (B-09) is the urgent half.**


## 4g. Autonomy model — D-068 (founder decision 2026-09-03)

**Supersedes the blanket "money and calendar always HITL" reading of D-021.** The old floor was category-based (calendar, money). The new floor is **reversibility × blast radius × consent**, because booking a new lead into an open slot is not the same risk as moving a customer's confirmed appointment, and quoting from the approved menu is not the same as charging a card. The old framing is why the agent behaves as a drafting assistant instead of an operator.

| Tier | Behaviour | Actions |
|---|---|---|
| **0** | Always automatic | classify · enrich · tag · dedupe · log · summarise. No external effect. |
| **1** | **Automatic by default**, undoable, logged | reply to a lead who just contacted the shop (inbound = recorded consent) · answer from the knowledge base · move a pipeline stage · add a note · **book into an open slot** · send a quote priced from the approved service menu |
| **2** | Automatic **once earned** (per action type, per shop, via existing `trust.ts` telemetry) | follow up with a lead gone quiet · propose a reschedule · quote with a discount inside a preset band |
| **3** | **Always asks. No graduation, no flag, ever.** | charge or refund a card · discount beyond band · cancel or move an **existing confirmed** appointment · send to a segment/campaign · contact an opted-out or DNC record · change prices |

**Non-negotiable at every tier including full auto:** consent records, quiet hours, STOP/opt-out. Enforced in code, test-locked. This is not bureaucracy — it is what makes Tier 1 defaults legally survivable.

- [ ] **B-17 — Implement the autonomy ladder.** Tier classification on every action type; Tier 1 **on by default** for new shops (today everything starts in suggest mode, which is why Gradia feels advisory); per-shop dial to loosen to Tier 2 or tighten to all-ask; rewrite the ALWAYS_HITL locking tests to encode Tier 3 rather than the old category rule. Every autonomous action still writes the full audit trail and stays undoable where the tier says undoable.
- [ ] **B-18 — Name the agents and show who does what.** Reference: dreamteam.co ships five named agents (Frank/lead qualification, Rachel/research, Sally/pipeline health, Raj/deal context, Alex/CRM admin) so a user instantly knows who did what. Gradia has one anonymous "agent" doing everything, which reads as vague and untrustworthy. Give the jobs names and surface them on Chief of Staff: who acted, in what role, on what, and why.

**Competitive note (dreamteam.co, fetched 2026-09-03):** their published autonomy model is *more* conservative than Gradia's target — "every AI action produces a draft card… the AI assists, you stay in control." Gradia's Tier 1 defaults are therefore a genuine differentiator, **provided** the consent machinery holds. What they do better today is **legibility** (named agent roster) and **zero forms** (capture from conversation instead of data entry) — B-18 and G-05/B-16 respectively.

## 5. Guardrails — never violated, no exceptions

1. **Tier-3 actions always ask a human first** (see §4g D-068): charge/refund, discount beyond band, cancel or move an **existing confirmed** appointment, send to a segment, contact an opted-out record, price change. No mode, flag, or refactor bypasses these. The locking tests are **rewritten to encode the ladder** — never deleted, never loosened.
1b. **Consent, quiet hours and STOP handling are non-bypassable at every tier, including full autonomy.** TCPA damages are $500–$1,500 per message; this is the constraint that makes aggressive autonomy elsewhere survivable.
2. **Guardrails live in code, never in prompts** — autonomy floors, send policy, quiet hours, STOP/opt-out, TCPA gates.
3. **No fake anything.** No mock data, fake metrics, dead controls, or simulated integrations. Numbers trace to real rows or render an honest zero-state.
4. **Standard CRM operations work with every AI feature off.**
5. **Tenant identity must be explicit.** Service-role Supabase bypasses RLS — `.eq("id", …)` alone is not authorization.
6. **Truth in claims.** Nothing is claimed that is not live and verified. Voice is not claimable until the acceptance run passes.
7. **`main` is founder-only.** Agents push `fix/*`, `auto/*`, `docs/*` and open PRs. They never merge, never write Vercel env, never touch `.env*`.

## 6. How a session works

1. Read this file. Pick the first unchecked item in §4.
2. If the ticket would touch more than 12 files, **split it** and build only the first half.
3. Build it. Write tests. Run the full gate (unit, integration, tsc, lint, build).
4. At 80% of the turn budget, **commit what exists** with a `wip(...)` message rather than stopping with nothing.
5. Push a branch, open a PR with a Vercel Preview link, write one paragraph on what to look at.
6. **Stop.** Do not start the next item.
7. Acceptance is the founder watching the behavior on the Preview. Green tests alone are BUILT, never DONE.


## 6b. Running a build on demand — `jarvis`

`~/Gradia/scripts/jarvis.sh` runs **one** ticket, any time of day, outside the nightly window.

```
jarvis            # next unchecked ticket in §4
jarvis B-03       # a specific ticket
jarvis --status   # what's running, what's next — runs nothing
```

It refuses to start on a dirty tree or while another session is running, cuts its own `auto/<ticket>-<time>` branch from main, keeps the Mac awake, and opens a PR. Founder alias: add `alias jarvis="$HOME/Gradia/scripts/jarvis.sh"` to `~/.zshrc`.

Guardrails loosened 2026-09-03 so sessions stop stalling on normal work: branch creation/switching, `git merge`/`rebase` (except into `main`), worktrees, cherry-pick, `git stash push/list/show`, `gh pr comment/diff`, `gh run`, `gh api`, `npx vercel logs/inspect/ls/env ls`, `supabase migration new`/`db diff`/`start`/`stop`, and npm/node/tsc/vitest are all allowed.

**Deliberately still denied, with reasons:** `git add .` / `git add -A` — this is exactly how the C-1 live database credential reached git history; exact staging stays. `git reset --hard`, `git stash pop/drop/clear`, `git branch -D` — data loss. `vercel env pull` — writes secrets to disk. `Edit(.env*)`, `Read(.env.local)`. `supabase db push/reset`, `vercel deploy/--prod`, `gh pr merge`, and any push to `main` — founder-only.

## 7. Founder-only — these block the build and only Harry can do them

- [x] ~~Confirm A2P 10DLC is live~~ — **DONE 2026-09-03: nothing registered.** See §3. Replaced by the item below.
- [ ] **Register Gradia's own A2P Brand + Campaign** (Twilio → Trust Hub → Registrations → A2P Brands → Create A2P Brand, then A2P Campaigns → Create). Needed to demo or test SMS at all. Record the brand type chosen, the fee, and the approval date — those numbers set every future shop's activation timeline (A-02, B-15b). Original instructions: In the Twilio Console: **Messaging → Regulatory Compliance → A2P 10DLC**. Report three things: (1) is there a **Brand** and is its status APPROVED, and which type — Sole Proprietor, Low-Volume Standard, or Standard; (2) is there a **Campaign** and is it APPROVED (a brand alone sends nothing); (3) is the number you test with attached to a **Messaging Service linked to that campaign** — this last one is the usual reason texts silently fail. Also note the per-brand fee and how long approval took, since that sets every shop's activation timeline (A-02).
- [ ] **Voice acceptance run** on a real inbound call.
- [ ] **Meta Business Verification + App Review** for `leads_retrieval`. Days-to-weeks at Meta's pace — start before B-07 is written.
- [ ] Create Stripe live prices for the three tiers (blocks B-02 acceptance).
- [ ] Merge PRs each morning. The loop stalls without this.

## 8. New ideas

Do not enter the build mid-week. They go to `docs/gradia-v2/program/decision-queue.md` and are reviewed once a week. This rule exists because on 2026-09-03 the product was redefined four times in one afternoon.

## 9. Where the old plans went

`10-roadmap.md`, `PLAN.md`, `GRADIA_MVP_PLAN.md`, `IMPLEMENTATION_PLAN.md`, `MVP_GATING_PLAN.md`, `program/autorun.md` and `program/release-1-scope.md` are **superseded by this file**. They remain as history and detail reference. `11-decision-log.md`, `04-capability-map.md` and the ticket files stay authoritative for detail on anything in §4.
