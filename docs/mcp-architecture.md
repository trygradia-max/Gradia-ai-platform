# Gradia Platform — MCP Server Briefing

Source-of-truth document for which external services Gradia integrates with, what each one powers per shop, and how they orchestrate together. This is the architectural target. See `docs/project-status.md` for where each piece actually stands today.

---

## What Is Gradia?

Gradia is a vertical AI SaaS built exclusively for auto detailers. It acts as a full digital office — capturing leads, booking appointments, handling calls, sending invoices, and communicating across every channel — all autonomously. The AI speaks as part of the user's team ("we made $3,200 today") and can be triggered by voice ("Hey Gradia, charge Smith $450 and book a follow-up in 6 months"). Every action either completes automatically or waits for human approval before firing.

---

## Implementation Status Per Integration

| Integration | Today | Pattern | Notes |
|---|---|---|---|
| Supabase | Built | Direct JS client + RLS | All CRUD goes through server actions; RLS-scoped per shop |
| Vapi | Built | Webhook receiver + native function tools | 4 tools: capture_lead, propose_booking, quote_service, lookup_customer_history |
| Slack | Built | Incoming webhook + interactivity callbacks | HMAC-verified; HITL approval cards live |
| Claude API | Built | Direct (Anthropic SDK / LangChain) | AI lead extraction, Whisper intent parsing |
| OpenAI API | Built | Direct (REST) | text-embedding-3-small for memory, whisper-1 for STT |
| Gmail / Aurinko | Roadmap | TBD | Email lead capture + outbound |
| Twilio (SMS) | Roadmap | TBD | Lead response, reminders, follow-ups |
| Google Calendar | Roadmap | TBD | `appointments` table exists; no UI/sync yet |
| Stripe | Roadmap | TBD | Invoices, charges, Whisper-triggered payments |
| HubSpot / Jobber | Roadmap | TBD | CRM sync — push leads, statuses, notes |
| Meta (FB / IG) | Roadmap | TBD | Inbound DM lead capture |
| Zapier | Fallback | TBD | Bridge tools without native MCP |

**Decision:** Each integration above can be wired as a direct API call OR as a Claude-callable MCP server. Direct is simpler for app-driven flows (HITL approvals, dashboard CRUD). MCP is needed for **agentic** flows where Claude itself orchestrates (Builder, Co-owner, BI chat — see "Three Personas" below).

---

## The MCP Servers

### 1. Supabase MCP — The Business Brain / Master Database

**Why we need it.** Every piece of Gradia runs through Supabase. Customer records, lead history, job notes, service menus, revenue data, and appointment logs all live here. Without it, Claude has no memory and no data to act on.

**What it powers.**
- Unified customer identity (links phone + email + social handles into one record)
- Service menu storage (prices, durations, package names)
- Lead and job history for every customer
- Revenue data queried when user asks "how much did we make today?"
- RAG memory via pgvector so Gradia remembers past customer details
- Gradia Whisper — every voice-to-action command writes back here

**Sample questions Claude answers via this MCP.**
- "How many new leads came in today?"
- "What's our total revenue this week?"
- "Pull up everything we know about John Smith"
- "What was our top-selling package last month?"
- "Has this customer contacted us before?"

**Key tables.**
- `customers` — master identity (name, phone, email, instagram_handle, facebook_id)
- `leads` — all inbound leads with source and status
- `services` — the detailer's service menu (price_cents, duration_minutes)
- `appointments` — all scheduled work
- `interactions` — every customer touchpoint across every channel, embedded (pgvector)
- `pending_actions` — the HITL queue
- `shops` — multi-tenant root

---

### 2. Vapi MCP — Inbound & Outbound Voice Agent

**Why we need it.** Gradia must answer every inbound call — even at 2am — qualify the lead, answer FAQs, and book appointments without the detailer picking up. Also powers Gradia Whisper, the voice-to-action feature where the detailer speaks commands hands-free.

**What it powers.**
- Inbound receptionist: answers calls, books jobs, handles FAQs based on the shop's menu
- Outbound follow-up calls to leads who haven't booked
- Gradia Whisper: detailer holds button, speaks a command, Vapi transcribes, Claude acts on it
- Spam call screening before routing to the human
- Call routing to the right team member

**Whisper flow.**
1. Detailer holds button → speaks command
2. Vapi transcribes speech to text
3. Claude parses intent from transcript
4. Claude triggers the correct MCP actions (Supabase write + Calendar create + Stripe charge)
5. Slack notification sent if any approval needed

---

### 3. Gmail MCP — Email Lead Capture + Outbound Email Agent

**Why we need it.** Leads come in via email from Yelp, website contact forms, and direct messages. Gradia must read these instantly, qualify the lead, and respond — without the detailer checking their inbox manually.

**What it powers.**
- Reading and parsing inbound lead emails from Yelp, website, Google
- Auto-drafting or auto-sending quote replies (HITL-gated)
- Following up with leads who didn't respond
- Sending appointment confirmations and reminders
- Outbound campaigns for repeat business
- All outbound emails include Gradia's name and role in the footer

**Rules.**
- Always signs emails with: "— Gradia AI | Digital Office for [Business Name]"
- Never impersonates the human owner
- Flags any email requiring human judgment to Slack before sending
- Only sends outbound email (never cold SMS without consent)

---

### 4. Twilio MCP — SMS Communication

**Why we need it.** Most detailing customers prefer text. Lead response time is critical — responding within 1 minute increases booking by 45%. Gradia must text leads instantly, send reminders, and follow up — all via SMS.

**What it powers.**
- Instant SMS response to new inbound leads (within 60 seconds)
- Appointment confirmation texts
- 24-hour and 1-hour reminder texts before jobs
- Follow-up texts after job completion requesting Google reviews
- Re-engagement campaigns
- All SMS includes Gradia's name at the bottom

**Rules.**
- Always ends messages with "— Gradia | [Business Name]"
- Never sends SMS without prior customer consent on file
- Flags bulk sends to Slack for human approval (HITL)
- Respects STOP/unsubscribe requests immediately

---

### 5. Google Calendar MCP — Appointment Scheduling

**Why we need it.** Every booking Gradia makes must land on the detailer's calendar instantly. Whether booked by the voice agent on a call, triggered by Gradia Whisper, or confirmed via text — the appointment must appear in real time with all job details.

**What it powers.**
- Creating appointments when a lead books (via any channel)
- Scheduling follow-up jobs ("book a 6-month detail from today")
- Blocking time slots when the detailer is unavailable
- Checking availability before confirming a booking
- Syncing with the Supabase `appointments` table
- Sending calendar invites to customers

**Example Whisper flow.**
> Detailer: "Just finished at Smith's, charge her $450 and book a follow-up in 6 months"
> → Gradia charges Stripe → checks calendar for an open slot 6 months out → creates event → texts customer confirmation

---

### 6. Slack MCP — Human-in-the-Loop Command Center

**Why we need it.** Gradia never fires a high-stakes action without giving the human a chance to approve or edit. Slack is the lightweight, mobile-friendly place where that happens.

**What it powers.**
- HITL approval cards: "[Approve] or [Edit]" buttons before quotes go out
- Cross-channel alerts: "Note: This customer also emailed 2 hours ago about ceramic coating"
- New lead notifications with lead details and heat score
- Gradia Whisper follow-up: "What time was the appointment?" when time wasn't specified
- Daily revenue summaries posted each evening
- Escalation alerts when Gradia can't handle something automatically

**Example card.**
```
🔥 New Lead — HOT
Name: Mike Torres
Source: Yelp
Interest: Full detail + ceramic coating
Estimated value: $800–$1,200

[✅ Approve Reply] [✏️ Edit] [❌ Skip]
```

---

### 7. Stripe MCP — Payments & Invoicing

**Why we need it.** Gradia handles the full job lifecycle. After a job is done, the detailer shouldn't have to log into another app to send an invoice. Gradia Whisper handles this with a single voice command.

**What it powers.**
- Creating and sending invoices after job completion
- Charging saved cards when authorized ("charge Smith $450")
- Sending payment links via SMS/email
- Tracking paid vs unpaid jobs
- Revenue data that feeds the Supabase financial tables
- Phase 3: BNPL (Buy Now Pay Later) for high-ticket services like PPF and ceramic coatings

**Whisper payment flow.**
1. Detailer says "charge Smith $450"
2. Gradia looks up Smith in Supabase → finds saved payment method
3. Stripe creates invoice → charges card
4. Confirmation SMS sent to customer
5. Revenue log updated in Supabase
6. Slack notification: "✅ Smith charged $450 — payment confirmed"

---

### 8. HubSpot / Jobber MCP — CRM Sync

**Why we need it.** Gradia collects incredibly detailed customer information — paint condition, interior preferences, previous job notes, vehicle details. That intel needs to live in a proper CRM that the detailer can reference and that syncs with their existing tools.

**What it powers.**
- Pushing new leads into the CRM the moment they come in
- Updating lead status as Gradia communicates (new → contacted → quoted → booked → completed)
- Specific notes ("John's black Tesla has light swirl marks on the hood — he's picky")
- Tagging customers by vehicle type, service history, and lifetime value
- Triggering CRM automations (5-star review request sequence post-job)
- Syncing with Supabase so data is never siloed

---

### 9. Meta Business MCP — Facebook / Instagram DMs

**Why we need it.** A huge portion of detailing leads come through Instagram and Facebook — especially from before/after posts. Gradia must capture these leads instantly and move them into the pipeline.

**What it powers.**
- Reading inbound DMs on Instagram and Facebook
- Instantly responding to "how much for a full detail?" type messages
- Qualifying the lead (vehicle type, service interest, location)
- Moving the conversation to SMS or phone for booking
- Logging the lead into Supabase with the source tagged
- Tracking cross-channel customers (social + email = flag to Slack)

**Rules.**
- Gradia identifies itself ("Hi! I'm Gradia, the AI assistant for [Business Name]")
- Never promises a price until the service menu is checked
- Moves the conversation off-platform to SMS/phone when ready to book
- All social interactions logged to Supabase for memory

---

### 10. Zapier MCP — Integration Bridge

**Why we need it.** Not every tool Gradia integrates with (Yelp lead forms, Google Business Profile, niche CRMs, review platforms) has a native MCP. Zapier fills that gap so no lead source goes uncaptured.

**What it powers.**
- Pulling leads from Yelp, Thumbtack, Angi into Supabase
- Triggering automations when certain Supabase events fire
- Connecting tools without their own MCP
- Bridging Slack actions to external apps when needed
- Safety net for workflow gaps

---

## The Missing MCP — Gradia Internal

A piece this brief doesn't yet describe but matters more than any of the above for the agentic vision:

**The Gradia Internal MCP** exposes our domain primitives — not raw external operations:

- `proposeLead({...})` — routes through `pending_actions` + Slack HITL
- `proposeBooking({...})` — same gate, structured payload for time + service
- `findCustomerByChannel({phone | email | ...})` — uses our normalizer + dedup
- `recordInteraction({...})` — embeds + persists to shared memory
- `searchCustomerMemory({...})` — semantic search across all channels
- `recentChannelActivity({...})` — "John also emailed 2 hours ago" cross-channel flag
- `quoteServiceFromMenu({...})` — reads shop's service menu

Without this layer, an agent calling Supabase MCP directly would bypass our HITL approval, customer dedup, memory writes, and RLS scoping. With it, those guarantees hold no matter what the agent decides to do.

This MCP is **the single most important piece** for making Gradia genuinely agentic and safe.

---

## Three Personas (Same MCPs, Different Lenses)

### Builder — Claude-Code-style
*"Help me build a campaign for all my Tesla owners"*

Tools: Supabase (read), Gradia Internal (write proposals), Stripe/Calendar/Gmail/Twilio (read-only preview).

Pattern: Claude reads broadly, proposes structured changes, every deploy lands in `pending_actions`.

### Co-owner — Cowork-style
*"How are we doing today? Who's coming in tomorrow? Should I follow up with Mike?"*

Tools: ALL MCPs (Supabase, Vapi, Gmail, Twilio, Calendar, Slack, Stripe, Meta, Gradia Internal).

Surface: in-app chat panel + Slack thread. Tone matches `HUMAN.md` ("we made $3,200 today").

### Backend Accountant
*"What's our top package this month? How much did Teslas bring in?"*

Tools: Supabase (read-only), Stripe (read-only).

Surface: BI chat at `/insights`. No HITL — pure reads.

---

## Per-Shop Isolation

Each shop needs its own scoped MCP endpoints with its own credentials. Right pattern:

**One MCP server per integration, per-shop scoped via auth token.** Claude session connects with the shop's bearer token; MCP server resolves the shop and uses RLS or per-shop OAuth credentials.

What this needs that we don't have yet:
- Encrypted per-shop OAuth/API token storage (Gmail, Stripe Connect, Twilio subaccounts, Meta tokens, etc.)
- Token rotation + refresh flow
- An auth proxy in front of MCP servers that maps `Bearer <shop-token>` → "this is shop_id X, use these credentials"

---

## Full Flow Example — Instagram DM at 11pm

1. **Meta MCP** → Gradia reads DM: "Hey how much for a full detail on my F-150?"
2. **Supabase MCP** → Checks if this person is already a customer → new record created via `findOrCreateCustomer`
3. **Meta MCP** → Gradia replies with pricing from service menu, asks for phone number
4. **Supabase MCP** → Lead status updated to "contacted"
5. **Slack MCP** → Notification sent: "🔥 New Instagram lead — F-150 full detail inquiry"
6. **Twilio MCP** → Follow-up SMS sent next morning if no response
7. **Google Calendar MCP** → Once booked, appointment created
8. **HubSpot MCP** → Full lead record pushed to CRM
9. **Stripe MCP** → Invoice created after job is done
10. **Twilio MCP** → Review request SMS sent 24 hrs after job

---

## Claude's Core Behavioral Rules When Using These MCPs

1. **Always check Supabase first** before any action — it has the ground truth on every customer and job
2. **Never take a high-stakes action** (charge, send quote, book) without a Slack HITL approval unless the detailer has pre-authorized it
3. **Log every interaction to Supabase** so memory stays intact across all channels
4. **Speak as "we/us"** not "you/your" — Gradia is part of the team, not a vendor
5. **Always identify as Gradia** in every outbound message (email footer, SMS signature, DM opener)
6. **Escalate to Slack** when any input is ambiguous (missing time, unclear service, payment dispute)
7. **Respect the niche** — Gradia has deep knowledge of auto detailing, PPF, ceramic coatings, paint correction, and the auto world. Use that knowledge in every customer interaction.

---

*This document is the architectural target. Update as MCPs are added or workflows change. Implementation status lives in `docs/project-status.md`.*
