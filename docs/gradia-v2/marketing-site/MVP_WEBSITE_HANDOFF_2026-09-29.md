# Gradia website update — complete copy and implementation handoff

Prepared September 29, 2026. This is a website brief, not evidence that the MVP is live. It contains copy ready for a pilot recruitment site, the intended MVP story, the route and component changes, and acceptance checks for Cursor. No website code, production settings, branches, or deployments were changed in preparing it.

## 1. The decision in one paragraph

Keep the useful design work on `site-v2`, but rewrite its story around **one Gradia Agent helping a detailing business move a lead from inquiry to booking and individual follow-up**. Include solo businesses and teams. Explain approvals plainly. Recruit for a controlled pilot with **Request pilot access**, not a free trial or an immediately available full product. Describe SMS, website forms and Meta as the intended initial pilot channels, each enabled only after verification. Email joins after inbox acceptance; inbound voice follows real-call and number-continuity acceptance. Do not ship the stale voice-first release plan or the older staff-only CRM brief.

## 2. Sources and what was actually checked

### Current requirements

The current source package is in another local worktree; it is absent from the stale `platform/main` checkout:

- `/Users/harryhatch/Gradia/worktrees/mvp-documentation-reconciliation/docs/CHEAT_SHEET.md`
- Same worktree: `docs/product/GRADIA_MVP_VISION.md`
- `docs/roadmap/MVP_IMPLEMENTATION_SEQUENCE.md`
- `docs/architecture/GRADIA_AGENT_ARCHITECTURE.md`
- `docs/architecture/AUTONOMY_APPROVAL_MODES.md`
- `docs/architecture/GRADIA_MEMORY.md`
- `docs/roadmap/POST_MVP_IDEAS.md`
- `docs/AI_WORK_LOG.md`

The September 11 approved product requirements supersede the September 3/8 plans, including voice-first D-069, staff-only targeting, and default autonomous customer actions. September 24 decisions remove the free trial and classify payments, full work orders, win-back, review texts and on-the-go owner access as future products. Do not overwrite Harry's uncommitted `platform/CONTEXT.md` to reconcile these documents.

### Repository and website evidence

- [Live homepage](https://trygradia.com/) checked September 29: old launch date, $20 pricing, lifetime discount, live call/booking claims, campaign examples and illustrative performance counts are still visible. This is a content observation, not verification of its original deployment date.
- Marketing checkout: `/Users/harryhatch/Gradia/marketing`, `site-v2` at `58bef16`. It is 22 commits ahead of the locally recorded `origin/site-v2`; the remote reference was not freshly fetched. Existing untracked `.playwright-mcp/` and `.wt-claims/` were left untouched.
- [PR #12](https://github.com/trygradia-max/Gradia-Web-Cursor/pull/12) was checked through GitHub CLI and is OPEN. It concerns failed waitlist persistence alerts, not the full website redesign.
- Local `platform/main` is `20e153a`; it is too old to decide the current MVP from its code alone.
- The September 24 documentation records membership and the Control Center draft editor merged in PR #48 at `247bb50`. Draft saving alone does not activate execution policy.
- The September 27 work log records local policy execution work, tested on a disposable stack, not pushed/merged/deployed at that point. Do not advertise it as live.
- Last documented production posture remains the restricted authentication release with 35 application write guards and operational channels held. This handoff did not re-audit the production configuration. Treat operational availability as unverified until release evidence says otherwise.

### Commercial contradiction to resolve

`CHEAT_SHEET.md` calls Core $99 / Pro $149 / Operator $249 confirmed. `POST_MVP_IDEAS.md` still says monthly prices are undecided. Both agree that seat terms are unresolved, the old billing remains, and there is no free trial. Preserve the three prices as the intended figures from the cheat sheet; **do not publish checkout prices, allowances or plan entitlements until the commercial sources are reconciled and actual billing matches**. This does not block an honest pilot request site.

## 3. Product definition for the website

**Plain-language category:** AI-powered CRM for detailing and automotive appearance businesses.

**Product sentence:** Gradia brings your customers, vehicles, conversations, quotes and calendar together, with one Agent to help move each lead toward a booking.

This is proposed customer-facing wording for the approved product scope. The internal vision calls Gradia a connected operating system. Neither phrase should imply payments, work orders, or a complete shop-management suite.

**Audience:** solo detailers and staffed detailing, ceramic coating, PPF and tint businesses, including a mobile service business. The MVP supports one operating location or mobile service area per workspace. Avoid promising multi-location routing or fleet management.

**Core story:** inquiry → customer and vehicle → qualification → menu-based quote → availability → approval where required → appointment → pipeline update → individual confirmation, reminder or check-in.

**Names:**

- **Gradia Agent:** the single assistant working across the business's enabled capabilities.
- **Gradia Whisper:** the communications experience across enabled channels. Voice notes are an input to the same Agent. It is not a separate bot or a second brain.
- **Chief of Staff:** the summary of activity, approvals and upcoming work. “Chief of Operations” refers to the same screen; use one label throughout the website.
- **Control Center:** operating rules and action controls. Do not imply every setting governs execution until the relevant runtime paths are accepted.

## 4. Claim matrix

“Approved MVP” below means required by the product plan. It does not mean available to a customer today.

| Capability | Evidence/status | Website treatment now |
| --- | --- | --- |
| Customers, vehicles, pipeline, quotes, calendar | Existing code foundation; full manual workflows still have acceptance gaps | Describe the product and show verified real screens with a product-preview label |
| Chief of Staff | Implemented; stale old plans incorrectly call it missing | Show an actual screen; do not invent revenue or booked-job results |
| One Agent from inquiry through booking | Approved MVP; complete durable loop still incomplete in the reviewed evidence | Describe as the pilot's intended workflow, not an already running service |
| SMS | Intended pilot channel; requires per-shop readiness and consent checks | “Pilot channels are enabled after setup and verification” |
| Website lead intake | Intended pilot channel; normalized public intake not established as accepted | Show as planned pilot intake, not “connect any website instantly” |
| Meta Lead Ads | Intended pilot channel; provider/app/intake acceptance required | Name specifically as Meta Lead Ads; never imply Facebook/Instagram DMs |
| Email | Transport and staged sending exist; full inbound/in-thread reply acceptance incomplete | “Email will join after its inbox and reply flow is verified” |
| Inbound receptionist | Code exists; real calls/forwarding/number continuity not accepted in reviewed evidence | Full-product direction only; keep live receptionist sales section gated |
| Outbound calling | Off for initial MVP | Omit |
| Approvals | Existing executor; granular policy execution is incomplete/not proven across all paths | Lead with approval-required defaults; qualify future per-action autonomy |
| Owner/manager/staff | Membership foundation merged; delegated execution incomplete | Approved team scope, not a claim of fully working team permissions today |
| Service menu, pricing, hours | Onboarding implementation exists | Show real setup screens; avoid “live in five minutes” |
| Capacity/conflict checks | Built components; last documented enforcement off | Never “cannot double-book” until deployed acceptance passes |
| Import/export | Export implementation exists; bounded import is target with acceptance needed | Export can be demonstrated if verified; do not promise effortless migration or every CRM connector |
| Memory | Existing shared context; reviewed structured-memory publication not complete | “Uses customer and shop context”; avoid “learns automatically from everything” |
| Individual follow-up | Approved loop, subject to separate action permissions | Clarify confirmation/reminder/check-in for the same lead/customer |
| Bulk/win-back/review campaigns | Future product | Remove from homepage, demo prompts and animations |
| Payments/POS/full work orders | Future product | “Not included in the initial release”; retire “never, ever” statements |
| Plans/seats/trial | Prices conflict across docs; entitlements unresolved; no trial | No trial CTA, no guessed seat counts, no working-checkout implication |

## 5. Ready-to-use homepage copy — pilot recruitment version

The following is the copy to use before operational release acceptance. Keep the status sentence visible near the first CTA. Do not bury it in an FAQ.

### Navigation

Product · How it works · Who it's for · FAQ

Primary button: **Request pilot access** → `/request-access`

Footer: Product · Pilot access · Privacy · Terms · Security, if its content is verified. Show Sign in only when the actual customer login destination has been verified and is appropriate for invited users. Do not send prospects into the old marketing portal by default.

### Hero

Eyebrow: **FOR DETAILING & AUTOMOTIVE APPEARANCE BUSINESSES**

# More time on the car. Less time chasing the booking.

Gradia brings your customers, vehicles, conversations, quotes and calendar together. One Gradia Agent is being built to help qualify leads, prepare quotes and move bookings forward—with you in control.

Primary CTA: **Request pilot access**

Secondary CTA: **See the planned workflow** → `/#how-it-works`

Status: **We're preparing a controlled pilot. Features and channels will be enabled as they pass verification.**

Visual: an actual Chief of Staff or customer/pipeline screen from a permitted demo environment. Caption: **Product preview · sample business data.** Do not put a “Live” badge on a design composition.

### Problem

## A good lead shouldn't depend on what you remember.

A customer asks about ceramic coating. Their vehicle details sit in a text, their quote is in another tool, and the next step is easy to lose. Gradia is designed to keep the customer, conversation and next action together.

### Workflow — `id="how-it-works"`

## From first inquiry to a clear next step.

Intro: **The workflow we're building for the pilot:**

1. **Capture the inquiry.** Bring leads from enabled sources into one customer record.
2. **Get the details.** Gather the service, vehicle, timing and questions that matter.
3. **Prepare the quote.** Use the shop's service menu and pricing; flag exceptions for review.
4. **Arrange the booking.** Check availability and present the proposed appointment for approval when required.
5. **Keep the record current.** Connect the appointment, pipeline stage and conversation, then prepare the appropriate individual follow-up.

Supporting note: **Initial pilot channels are SMS, website forms and Meta Lead Ads, activated individually after verification. Email and inbound calls follow their own readiness checks.**

### Core CRM

## One place for the customer and the next step.

- **Customers & vehicles:** contact details, vehicle information, notes and history together.
- **Pipeline:** see where each lead stands and what needs to happen next.
- **Quotes & calendar:** connect the service request, quote and appointment.
- **Conversations:** keep the context that explains the next action.

Section note: **These are the core workflows we're preparing for the pilot. The CRM is designed to remain useful with AI turned off.**

### Gradia Agent and control

## Gradia prepares the work. You decide what goes out.

Ask Gradia to find a customer, prepare a quote or draft the next reply. Customer-facing actions start with approval required. The finished controls will let owners enable specific actions within their shop's rules.

Illustrative prompts, visibly labeled as planned examples until verified:

- “Show me ceramic coating inquiries waiting for a quote.”
- “Prepare a quote for this customer's SUV using our service menu.”
- “Draft a reply asking which day works for them.”

Do not demonstrate bulk messaging, autonomous execution or a permission toggle that only saves a draft.

### Chief of Staff

## Open Gradia. See what needs you.

Review proposed actions, upcoming appointments and recent activity in one place. See what is waiting for approval and what has actually happened.

Visual: actual implemented Chief of Staff screen with sample data and preview caption. Show held/failed states truthfully. Do not turn proposed quote value into revenue.

### Who it's for

## Built around the way appearance businesses work.

Detailing, ceramic coating, PPF and tint—from a solo mobile business to a shop with a team. The MVP is designed for one operating location or mobile service area, with clear responsibility for the next step.

### Final CTA

## Help shape Gradia in a real shop.

Tell us how your business handles inquiries today. Request access to the controlled pilot, and we'll follow up about fit and availability.

Button: **Request pilot access**

Note: **Requesting access does not create an account or start a subscription.**

### After pilot acceptance

Only after there is evidence for the particular shop/channel set, replace “is being built to help” with “helps,” “planned workflow” with “workflow,” and the preparation notice with: **Pilot access is limited. Available channels are confirmed during setup.** Remove future tense feature by feature, not with a global copy replacement. Keep voice and other unaccepted channels explicitly unavailable.

## 6. FAQ copy

**What is Gradia?**
Gradia brings a detailing business's customer records, vehicles, conversations, quotes and calendar together, with one Agent to help move leads toward appointments.

**Can I use it today?**
We're preparing a controlled pilot. You can request access now; access and available features will be confirmed before onboarding.

**Is it only for larger shops?**
No. The MVP is designed for solo businesses and teams, at one location or within one mobile service area.

**Does Gradia send messages or make bookings without asking?**
Customer-facing actions start with approval required. The planned controls allow the owner to enable specific actions within defined rules. Connecting a channel does not automatically allow every action on it.

**Which channels will the pilot support?**
The initial pilot is planned around SMS, website forms and Meta Lead Ads. Each channel must pass setup and verification before it is enabled. Email follows acceptance of its inbox and reply flow. Inbound phone reception follows real-call and forwarding checks.

**Can I keep my phone number?**
Keeping your existing number is a requirement for the phone rollout. Forwarding and number continuity must be verified before we offer the receptionist for your business.

**Does Gradia take payments or manage work orders?**
Payments, deposits, invoicing, point of sale and full work orders are not included in the initial MVP. Its focus is the customer inquiry, quote, booking and individual follow-up.

**Can it message all my old customers or request Google reviews?**
Those campaigns are outside the initial MVP. The planned follow-ups are confirmations, reminders and check-ins for the individual customer already in the booking workflow.

**Is there a free trial?**
No free trial is offered. Pricing and pilot terms will be shared before you commit.

**Can I bring existing customer records?**
Bounded customer and vehicle import is part of the intended MVP. We'll confirm supported formats and available migration help before onboarding. Do not imply that every external CRM connects or syncs.

## 7. Supporting pages

| Route | Content and publication rule |
| --- | --- |
| `/` | Pilot recruitment copy above; no paid-access implication |
| `/product` | H1 “The customer, the conversation and the next step—together.” Show CRM, Agent, Chief of Staff and intended lead workflow. Distinguish existing screens from planned/verified channel behavior |
| `/request-access` | Working pilot request form; see below |
| `/demo` | Actual recordings of verified behavior, each with channel and preview/pilot status. If no recording exists, use “Product preview” and screenshots, not a pretend playable demo |
| `/industries` | Detailing, coating, PPF/tint and mobile examples. Use the same truthful capability set across them |
| `/industries/fleet` | Keep gated; no fleet-account implication |
| `/receptionist` | Keep gated until acceptance. An explanatory FAQ on the main site is sufficient before then |
| `/pricing` | Keep transactional pricing gated until numbers, contents, usage terms and billing match. No free trial. If a temporary public page is needed, say “Pilot pricing and terms are confirmed before onboarding” and link to access request |
| `/security` | Specific verified data/access practices only. No invented certifications, blanket guarantees or claimed recovery targets |
| `/privacy`, `/terms` | Preserve access and existing consent links; review product-specific changes before claiming legal coverage |
| `/resources` | Retain relevant useful pages after sweeping them for outdated prices, trials, channels and features |
| Login | Verify actual platform destination and invited-user access; do not invent an app subdomain or treat marketing `/portal` as the product |

### Pilot request form

Recommended fields: name, business email, business name, service type, solo/team selection, current tools and a short “What would you like Gradia to handle?” field. Phone optional unless needed for an explicitly chosen contact method. Map changes to the actual server schema; never silently discard new fields.

Submit button: **Request pilot access**

Success: **Your request is saved. We'll follow up about fit and availability.** Only show this after confirmed durable persistence.

Failure: **We couldn't save your request. Please try again.** Preserve entered fields. Rate limits should explain when to retry. Do not show a booked demo, paid subscription, or accepted pilot place merely because a request was received.

The website pilot request form and the future shop-customer lead intake are different workflows. Reusing waitlist storage does not build the product's lead intake capability.

Preserve approved privacy/terms and consent behavior. Pilot interest is not blanket consent for automated marketing texts. This brief does not supply replacement legal consent language. Verify the redesign preserves the September 5 A2P form/API changes; the checked `site-v2` handler's payload still lists the older fields.

## 8. Pricing and commercial copy

- Remove $20/month, the +$29 voice offer, Founding 100, lifetime discounts, launch countdowns and July 10, 2026 everywhere.
- Remove “Start your trial,” “14-day guided trial,” trial allowances and free/unlimited AI promises everywhere, including hidden pages, metadata and structured data.
- Intended figures in the cheat sheet: **Core $99 / Pro $149 / Operator $249 monthly**. Resolve the contradictory commercial register before publishing. Do not infer package contents from old tier tables.
- Do not publish guessed seats, $19 staff/$29 manager add-ons, credits, minute allowances, overages or migration promises.
- Keep plan amounts and feature entitlements tied to the validated commercial source/configuration. Do not maintain separate invented marketing defaults.
- Do not use “Buy now” or paid account signup until the actual checkout and operational access path have been verified together.

## 9. Exact implementation map for Cursor

Start by reading applicable repository instructions and installed Next.js documentation. Work on a reviewable branch based on `site-v2`; do not replace its unpushed work or edit the stale platform application. This brief requests a website update, not automatic production publication.

| File/surface in `marketing/` | Required change |
| --- | --- |
| `lib/site-config.ts` | Replace staff-only description and named-competitor hero copy; rename trial CTA configuration to pilot/access terminology; point it at a real `/request-access` route |
| `components/site/SiteNav.tsx`, `SiteFooter.tsx` | Consistent access CTA, truthful route visibility and verified login |
| `components/site/sections/Hero.tsx`, `Problem.tsx`, `ConnectedFlow.tsx` | New pilot story and conspicuous status; remove automatic every-channel/voice promises |
| `CoreSystem.tsx`, `Operations.tsx` | CRM and actual Chief of Staff; remove jobs/payments and invented results |
| `AgentControl.tsx`, `AsksFirst.tsx`, `TeachGradia.tsx` | One Agent, approval defaults, no unverified runtime controls or automatic memory learning claims |
| `FinalCta.tsx` | Remove self-linking `/#trial` button; use the working access route |
| `components/site/faqs/home.ts`, `faqs/product.ts` | Replace with current scope, no-trial and availability answers |
| `components/site/product/*` | Replace old three flagships/SMS-in-60-seconds story; remove campaigns from both visible and dormant launch content |
| `components/site/industries/*` | Include solo/team parity; remove old solo exclusion and fleet functionality |
| `components/site/demo/DemoContent.tsx`, `sample.ts` | Real accepted operations or labeled previews; no fake sent messages/bookings; no customer-private data |
| `components/site/pricing/*`, `flags.ts` | Strip trials and stale allowances; leave unaccepted pricing/receptionist/fleet gates closed |
| `app/request-access/page.tsx` and form/API | Add actual conversion destination, schema validation, durable submission and truthful result states |
| `app/api/waitlist/route.ts` | Reuse only after reviewing latest consent and persistence behavior; use an explicit migration if storing a new request type |
| `app/layout.tsx`, `opengraph-image.tsx`, SEO components | Remove stale pricing/date/trial and broad delivery claims |
| `lib/site-routes.ts`, `middleware.ts`, `app/sitemap.ts` | Ensure launched pages are reachable and indexed; gated pages stay out; flags alone do not update route allowlists |
| `claims-matrix.md`, `COPY_BRIEF.md`, `CURSOR_BRIEF.md`, launch notes | Replace superseded D-067/D-069 claims with this source package and evidence states |

Do not broaden route access to API/admin paths while changing the marketing allowlist. Existing permanent redirects may remain cached; test direct routes and canonical URLs on the preview and after publication.

### SEO copy

Title: **Gradia | AI CRM for Detailing Businesses**

Description: **Meet Gradia: customer records, quotes and scheduling with an AI Agent for detailing businesses. Request access to our controlled pilot.**

Social headline: **More time on the car. Less time chasing the booking.**

Social subline: **Customers. Quotes. Scheduling. One Gradia Agent.**

Use canonical URLs for published routes only. Structured data must match visible content. Omit Offer, AggregateRating and review data without actual supporting content and agreed prices.

### Visual direction

Reuse the current redesign's typography, spacing and restrained palette. Build the story around actual product screens. Keep motion limited to explaining steps; respect reduced motion. Include mobile, keyboard, focus and error states. No fabricated customer logos, testimonials, “62%” statistics, filled-calendar outcomes or revenue counters. Label sample records at the visual, not only in the footer.

## 10. What to do with the existing branches

1. **Claims cleanup:** compare the reported `marketing/claims-cleanup` work with current marketing main. It is the fastest candidate for removing obsolete live promises, but inspect the diff and preserve the current waitlist/consent flow. Do not blindly merge or duplicate it.
2. **`site-v2`:** retain its design work. Replace the old source briefs and copy using this handoff; add a working conversion path. Its current claim matrix is September 3 material and is not current MVP authority.
3. **PR #12:** review for applicability to the chosen request backend and current main, including conflicts. Carry forward useful failed-persistence alerting, but do not silently merge the old PR as part of the redesign. The request must remain recoverable even if alert delivery fails.
4. **Preview:** verify content, routes, form behavior and claims before production cutover. Confirm the actual current deployment mechanism; old HANDOFF says manual deploy while the supplied report says main auto-deploys. Treat merging main as potentially publishing until checked.

## 11. Acceptance checklist

### Marketing update can pass before the product is live

- [ ] Every primary CTA reaches a real pilot request form, including the bottom CTA.
- [ ] Form success follows a saved record; duplicate, invalid, rate-limited and failed submissions behave correctly.
- [ ] Existing privacy/terms and approved consent handling survive the redesign.
- [ ] No $20/$29, July launch date, founding/lifetime offer or free trial remains in delivered text or metadata.
- [ ] No live voice, guaranteed bookings, 60-second SLA, campaigns, payment/work-order, instant migration or unverified integration claim remains.
- [ ] Solo and team businesses are both represented; no guessed seat counts.
- [ ] Pilot status appears in hero, product channel list and access form.
- [ ] Product recordings/screenshots match actual permitted behavior and use anonymized/sample records.
- [ ] `/product`, `/request-access`, legal routes and all navigation links work; sitemap matches published routes.
- [ ] Receptionist, transactional pricing and fleet routes remain gated unless their evidence is supplied.
- [ ] Mobile layouts, keyboard navigation, form focus, reduced motion and loading/error states work.
- [ ] Run repository type/build/lint checks appropriate to changed files and exercise the form against permitted test storage. Do not send test business messages or remove platform release guards.

### Evidence required before changing the copy to “available”

- [ ] Current production release posture is documented and operational access is intentionally enabled.
- [ ] One real end-to-end lead → correct customer/vehicle → qualification → quote → approved booking → pipeline → appropriate follow-up is accepted for each marketed channel.
- [ ] Permissions, consent, opt-out, retries, uncertain delivery, revoked access and booking capacity are verified in those paths.
- [ ] Team/manager features work through actual execution, not just membership or a policy draft editor.
- [ ] Email includes working inbound and in-thread reply before full email-channel claims.
- [ ] Voice includes real inbound call, forwarding, retained number and escalation acceptance before receptionist claims.
- [ ] Prices, entitlements, usage limits, checkout and access match before selling subscriptions publicly.

## 12. Copy-and-paste task for Cursor

> Update the Gradia marketing site using `MVP_WEBSITE_HANDOFF_2026-09-29.md` as the website brief and the September 11 MVP source package plus September 24 commercial decisions as product authority. Preserve the useful `site-v2` design. Build a truthful pilot recruitment site with a working Request pilot access form, current homepage/product/FAQ copy, updated metadata, and matching routes/sitemap. Remove old $20 pricing, founding discounts, July launch date, all free-trial language, staff-only targeting, campaign examples and unverified live channel claims. Use one Gradia Agent; explain Whisper as the shared communications experience. Keep pricing, receptionist and fleet sales content gated. Do not claim the end-to-end MVP or runtime controls are live merely because code exists. Preserve existing privacy/terms and approved consent behavior; inspect current main's A2P changes before reusing the older branch's form handler. Review PR #12 for useful persistence-failure handling without automatically merging it. Work on a reviewable branch, run appropriate checks, provide the preview and a copy/claims audit, and report unresolved publication gates. Do not merge main or deploy as part of this handoff.

## Work record

[AI: codex] [DATE: 2026-09-29] [AREA: docs] [STATUS: done]
Prepared this copy and implementation package after reading current MVP sources, marketing branch files and the live homepage. Corrected the initial stale voice-first interpretation after locating the newer approved source worktree. Recorded pricing-source disagreement and unverified production status. Website implementation, publication and product activation remain separate work.
