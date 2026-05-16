# Gradia — Project Status

**Snapshot date:** 2026-05-16
**Phase:** Phase 1 channel layer code-complete. Every inbound channel
in the brief (voice, email, SMS) is shipped end-to-end, plus full
outbound SMS, Google Calendar via Aurinko, Stripe Connect with the
unicorn-moment "charge X $Y" Whisper demo, the unified `/customers`
view, and at-rest encryption for the only credential material we
hold. External operator setup (Vapi assistant config + phone number,
Aurinko Gmail OAuth app, Twilio number, Stripe Connect onboarding)
is what stands between "code-live" and "demo-live."

---

## Shipped (live in `main`)

### Foundation
- Next.js 16 + React 19 + Tailwind 4 + Supabase SSR
- Magic-link auth with redirect-protected dashboard layout
- Multi-tenant Supabase schema with RLS scoped per `shop_id`
- Project doctrine: `DESIGN.md`, `OPERATIONS.md`, `HUMAN.md`, `PROJECT_BRIEF.md`

### Onboarding & Business Brain
- 3-step onboarding wizard (`/onboarding`): shop → service menu → confirm
- Mobile-first, eager-save, resume-aware
- `shops` table with `location` and `phone`
- `services` table populated through the wizard — the Business Brain

### Customer identity layer
- `customers` table with partial unique indexes on phone / email / instagram / facebook (per shop)
- `findOrCreateCustomer` helper with normalizers (phone, email, IG handle, FB ID)
- `findCustomerByChannel` lookup-only sibling
- `customer_id` FK on `leads`, `interactions`, `appointments`
- **Customers stay deduped** across every channel; the surviving
  identity row absorbs identifiers from whichever channel adds new
  information first
- **Manual merge UX** at `/customers/[id]`: pick a duplicate via
  search, history (leads + interactions + appointments) reassigns
  from loser → winner first (interactions.customer_id is ON DELETE
  CASCADE — wrong order would destroy the timeline), unique-violation
  conflicts on identifier absorption surface as toasts rather than
  aborting the merge

### HITL approval engine
- `pending_actions` table — action_type enum:
  `create_lead | add_note | book_appointment | send_sms | charge_customer`
- `lib/approvals.ts` — atomic claim, executor per action_type,
  idempotent, rolls back on executor failure
- Slack approval cards (HMAC-verified) with Approve / Edit buttons,
  per-type variants for lead / note / booking / SMS / charge
- `/approvals` dashboard view + per-item editor at `/approvals/[id]`
  with five variants (create_lead, add_note, book_appointment,
  send_sms, charge_customer)
- Slack "Edit requested" cards deep-link straight to `/approvals/[id]`
- `decided_by_slack` and `decided_by_user` columns for audit
- Slack stale-card behavior: dashboard-decided actions don't update
  the original Slack card (known limitation, needs bot token +
  `chat.update` for the fix)

### Shared memory layer
- `interactions` table — one row per turn across all channels
- pgvector enabled, HNSW cosine index
- `match_customer_memory` RPC for semantic search
- OpenAI `text-embedding-3-small` (1536 dims, baked into schema)
- `lib/memory.ts` primitives: `recordInteraction`, `recentInteractions`,
  `searchCustomerMemory`, `recentChannelActivity`
- Best-effort embedding — if OpenAI fails, the row still lands with
  NULL embedding

### Voice receptionist (Vapi)
- `/api/vapi/webhook` route with HMAC verification + per-shop routing
  via `shops.vapi_assistant_id`
- End-of-call transcripts ingested into the memory layer
  (channel=voice)
- Four function tools (`lib/vapi-tools.ts`):
  - `capture_lead` — HITL via Slack
  - `propose_booking` — emits `book_appointment` when a parseable
    ISO time is provided (else falls back to `create_lead` quoted)
  - `quote_service` — reads the menu, speaks TTS-friendly strings
  - `lookup_customer_history` — recalls customer + cross-channel
    sync flag
- `/settings` → **Voice receptionist** card: paste-the-ID flow
- Doc: `docs/vapi-go-live.md`
- **Still requires** Vapi dashboard config + phone number provisioning

### Email receptionist (Aurinko)
- Inbound: OAuth start/callback (HttpOnly state nonce), webhook with
  `X-Aurinko-Signature` HMAC-SHA256 (`v0:{ts}:{body}`, 5-min replay
  window), Haiku classifier, HITL pending
- Outbound (Mail.Send scope authorized; nurture UI is a follow-up)
- `/settings` → **Email receptionist** card with Connect Gmail /
  Connected / Disconnect; surfaces all 8 callback states as toasts
- Doc: `docs/aurinko-go-live.md`
- **Still requires** creating the Aurinko app and dropping env vars
  in Vercel

### SMS receptionist (Twilio)
- **Inbound:** `/api/twilio/sms` webhook (HMAC-SHA1 on URL + sorted
  form pairs), classifier tuned for short-form (one-word follow-ups
  flagged as not-leads), HITL pending — Slack approval card per inbound
- **Outbound, operator-direct:** `<SmsQuickReply>` on `/approvals/[id]`
  for SMS-source pendings and on every customer detail page when the
  shop has a Twilio number; no HITL cycle since the operator is the
  human
- **Outbound, HITL-gated:** `send_sms` pending_action type with
  approval engine executor; full editor variant; Slack card with To /
  Reason / Message preview + "Approve & send" button
- **Delivery callbacks live:** every send passes a `StatusCallback`;
  `/api/twilio/sms/status` verifies signature and updates
  `interactions.metadata.twilio_status` / `twilio_status_updated_at` /
  `twilio_error_code` so the customer detail page can surface
  delivery state when we wire that UI
- Three live drafter triggers on `send_sms`:
  - Inbound auto-draft: classifier marks `is_lead` → drafts a reply
    ("…— Gradia at {shop_name}"), one approval card per lead + one per
    draft
  - Booking confirmation: `executeBookAppointment` queues a draft
    right after the calendar event lands
  - 24h reminder cron: `/api/cron/reminders` (Vercel hourly,
    `CRON_SECRET` auth) finds appointments 23–25h out, drafts and
    stages a reminder, stamps `appointments.reminder_pending_action_id`
    so the next tick skips
- `/settings` → **SMS receptionist** card with E.164 input + webhook
  URL displayed
- Doc: `docs/twilio-go-live.md`, `docs/outbound-sms.md`

### Calendar (via Aurinko)
- Reuses the existing Aurinko OAuth — `Calendar.ReadWrite` scope
  alongside `Mail.*`, so one connection covers both channels
- `book_appointment` action type. On approve, `executeBookAppointment`
  creates the Aurinko calendar event, inserts the lead (status=booked),
  inserts the appointment row with the linked `aurinko_event_id`,
  captures the booking's timezone for downstream reminders
- `/schedule` reads upcoming events from Aurinko, groups by day,
  surfaces a "Today" pill
- Voice `propose_booking` tool emits `book_appointment` when it can
  parse a real ISO datetime; graceful fallback to quoted lead otherwise
- Doc: `docs/calendar-go-live.md`

### Payments (Stripe Connect Standard)
- Onboarding: `/api/stripe/connect/start` creates the connected
  account if needed and returns an account-link URL; user finishes
  Stripe-hosted onboarding; `/api/stripe/connect/return` refreshes
  `shops.stripe_charges_enabled`
- `charge_customer` action type. Executor (`lib/stripe.ts`) finds-or-
  creates a customer on the connected account, creates an invoice
  item, creates the invoice with `collection_method=send_invoice`,
  sends it — Stripe emails the customer a hosted-payment URL. No
  card-on-file UX required
- Whisper third intent: "charge Smith $450 for ceramic" parses to
  `{ customer_name, amount_cents, description }`; if a matching
  customer record exists with an email, the pending lands pre-filled;
  else operator adds the email via `/approvals/[id]` before approving
- `/settings` → **Payments** card with three states (Connected +
  charges enabled / Needs more info / Not connected) + Disconnect
- Doc: `docs/stripe-go-live.md`

### Gradia Whisper (voice-to-action)
- Mobile mic button on dashboard
- `/api/whisper/process` — OpenAI Whisper transcribes → Claude
  classifies intent → pending_action → Slack
- Three intent types: `create_lead`, `add_note`, `charge_customer`

### Dashboard surfaces
- `/dashboard` — overview + Whisper button + AI lead section + live
  lead feed
- `/leads` — full lead table
- `/customers` — search-driven index with lead_count + last_seen_at
- `/customers/[id]` — three-card detail (identity, activity timeline
  for last 50 touchpoints across every channel, pipeline) + Quick
  Reply SMS card + Merge duplicate dialog
- `/approvals` — pending HITL items (badges per type)
- `/approvals/[id]` — editor handles all five action types
- `/schedule` — real calendar surface (Aurinko-backed)
- `/settings` — Voice / Email / SMS / Payments cards

### Security
- **Aurinko access tokens encrypted at rest** (AES-256-GCM via
  `src/lib/crypto.ts`, `ENCRYPTION_KEY` env). Migration
  `20260515200000_encrypt_aurinko_token` drops the plaintext column
  and adds `aurinko_access_token_enc`. DB dumps, Supabase support
  read access, and any non-env-side database compromise no longer
  expose tokens.
- All inbound webhooks signature-verified before processing (Vapi,
  Aurinko, Slack interactivity, Twilio inbound + status, cron).
- Service-role Supabase client is server-only and only invoked from
  webhook routes / approval execution. `NEXT_PUBLIC_*` env vars are
  Supabase URL + anon key only (both designed to be public).
- Stripe Connect Standard — we never store per-shop secret keys,
  only the `acct_XXX` connected-account id.
- Twilio pilot model — one global account in env, per-shop only
  stores the owned phone number.

### Tooling state
- `npm run build` clean
- `tsc --noEmit` clean
- ESLint clean
- `next.config.ts` allows ngrok hosts for mobile testing
- 19 migrations applied to remote Supabase (all idempotent)
- `vercel.json` registers the hourly reminder cron

---

## Pending integrations

| Integration | Status |
|---|---|
| Vapi voice receptionist | Code complete; **awaits Vapi dashboard config + phone number** |
| Aurinko Gmail (inbound + outbound auth) | Code complete; **awaits Aurinko app + env vars + Connect Gmail click** |
| Twilio SMS (inbound + outbound + delivery status) | Code complete; **awaits Twilio number + webhook config in console** |
| Google Calendar via Aurinko | Code complete; piggybacks on the Aurinko Gmail connection |
| Stripe Connect Standard | Code complete; **awaits Stripe platform setup + per-shop onboarding** |
| Aurinko outbound email (HITL nurture) | Not started — Mail.Send scope is granted, no UI / no trigger yet |
| HubSpot / Jobber CRM push | Not started |
| Meta DMs (IG / FB inbound) | Not started (Phase 3 stretch) |

**Scope decision (2026-05-11):** Outbound voice (Vapi-driven outbound
calls for nurture) removed from the roadmap. Outbound email + SMS
replace it as the nurture channels. Inbound voice (Vapi receptionist)
stays in scope.

---

## Pending product work

- ~~Per-shop Vapi assistant routing~~ ✓ shipped 2026-05-12
- Vapi assistant config + phone number provisioning — operator action
- ~~`book_appointment` as a real action type~~ ✓ shipped 2026-05-12
- ~~`/leads/pending/[id]` editor~~ ✓ shipped at `/approvals/[id]` 2026-05-12
- ~~`/customers` view~~ ✓ shipped 2026-05-14
- ~~Manual customer merge~~ ✓ shipped 2026-05-14
- Cross-channel sync flag in the dashboard UI (the
  `recentChannelActivity` primitive exists; needs a small UI surface)
- Slack stale-card fix (bot token + `chat.update`)
- ~~Real `/settings` page~~ ✓ shipped 2026-05-12
- ~~UI/UX copy polish pass~~ ✓ shipped 2026-05-12 (deeper visual
  redesign still queued)
- ~~Twilio delivery-status callbacks~~ ✓ shipped 2026-05-16
- Delivery-status UI surface on customer detail (badge for failed
  outbound) — primitives in place, no UI yet
- Stripe paid-status webhook — closes the loop on collection
- Aurinko token refresh flow — tokens are long-lived but expiry
  recovery currently requires Disconnect + Reconnect
- BI chat (Phase 2)
- Agent Builder + Co-owner chat surfaces (Phase 2)

---

## Architecture decisions

### Direct integration over MCP for Phase 1
Every integration is a direct API call — Supabase JS client,
Anthropic SDK, OpenAI REST, Slack webhooks, Vapi webhooks, Aurinko
REST + webhooks, Twilio REST + webhooks, Stripe REST. This is the
right pattern for app-driven flows (HITL approvals, dashboard CRUD).

**MCP servers are a Phase 2 build**, needed once Gradia becomes
genuinely agentic (Builder / Co-owner / BI chat personas). See
`docs/mcp-architecture.md` for the target architecture.

The critical Phase 2 piece is the **Gradia Internal MCP** wrapping
our domain primitives (`proposeLead`, `findCustomerByChannel`,
`recordInteraction`, etc.) so Claude can't bypass HITL / dedup /
memory by going to raw Supabase MCP.

### Multi-tenant secrets (partial — encryption at rest)
Aurinko access tokens (the one piece of real credential material we
hold per shop) are AES-256-GCM at rest via `ENCRYPTION_KEY`. Stripe
Connect Standard means we never store per-shop Stripe keys. Twilio
pilot uses one global account. Vapi only stores assistant IDs (not
credentials).

What's *not* built yet:
- Token refresh / rotation flow (Aurinko tokens are long-lived; on
  expiry, operator disconnects + reconnects)
- Audit log of credential operations
- Per-shop Twilio subaccounts (when we need full revenue isolation
  for SMS billing)

### Hand-rolled fetch over SDKs
Aurinko, Twilio, and Stripe all use hand-rolled `fetch` wrappers
(`src/lib/{aurinko,twilio,stripe}.ts`). Pattern: no SDK dependency
churn, full control over auth headers (Bearer / Basic / `Stripe-
Account`), and consistent error shape (`*Error` classes with
status + code).

---

## Immediate next step (operator action)

1. **Apply pending migrations** (`supabase db push`):
   - `20260512100000_shop_vapi_assistant_id.sql`
   - `20260512110000_shop_aurinko.sql`
   - `20260512120000_shop_twilio.sql`
   - `20260512130000_book_appointment.sql`
   - `20260513100000_send_sms_action.sql`
   - `20260514100000_appointment_reminder.sql`
   - `20260515100000_stripe_charge.sql`
   - `20260515200000_encrypt_aurinko_token.sql`
2. **Set env vars in Vercel** (full list in `.env.example`):
   `AURINKO_CLIENT_ID/SECRET/SIGNING_SECRET`,
   `TWILIO_ACCOUNT_SID/AUTH_TOKEN`,
   `STRIPE_SECRET_KEY/CONNECT_CLIENT_ID`,
   `CRON_SECRET`, `ENCRYPTION_KEY`.
3. **Provider go-lives** — work through, in this order:
   - `docs/vapi-go-live.md`
   - `docs/aurinko-go-live.md` (covers calendar too)
   - `docs/twilio-go-live.md`
   - `docs/stripe-go-live.md`

After those, the headline pitch — voice + email + SMS + calendar +
payments all routing through one HITL brain — is live end-to-end.

---

## Next engineering (priority order)

1. **Aurinko outbound email** — Mail.Send is authorized, no UI yet.
   Mirrors the SMS HITL primitive (drafter + `send_email` action
   type + Slack card + reply triggers from inbound classifier).
2. **Stripe paid-status webhook** — closes the loop on collection so
   "Smith paid" surfaces inside Gradia rather than only in the Stripe
   Dashboard.
3. **Delivery-status UI** — the Twilio status payload now lands in
   `interactions.metadata` but there's no badge surface yet. Small
   chunk: failed-delivery indicator on the customer detail timeline.
4. **Cross-channel sync flag in dashboard** — `recentChannelActivity`
   exists; needs a UI surface ("John also emailed 2h ago about
   ceramic coating").
5. **BI chat** (Phase 2) — Perplexity-style "how many leads this
   month, what's our top service" over the shared memory + structured
   tables.

---

## Since the 2026-05-12 snapshot

Shipped on `main`:

- Twilio SMS — full inbound + outbound (operator-direct + HITL
  primitive + three drafter triggers + 24h reminder cron) + delivery
  status callbacks
- Google Calendar via Aurinko + `book_appointment` action type +
  `/schedule` as a real surface
- Stripe Connect Standard + `charge_customer` action type + Whisper
  third intent ("charge X $Y for Z")
- `/customers` index + detail (timeline across every channel) +
  manual merge dialog
- Aurinko access tokens encrypted at rest
- Project status doc refresh
