# Gradia — Project Status

**Snapshot date:** 2026-05-12
**Phase:** Phase 1 MVP code-complete. Two external setups remain
(Vapi phone line, Aurinko Gmail app) before the demo is end-to-end
live with real voice + real email.
**End-to-end verified (as of last snapshot):** Whisper voice → Slack
approval → lead landed in `/leads`. Vapi + Aurinko paths code-complete
but await dashboard configuration on the provider side.

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
- `customer_id` FK on `leads`
- Customers are deduped across every channel that calls into the helper

### HITL approval engine
- `pending_actions` table — action_type enum: `create_lead` | `add_note`
- `lib/approvals.ts` — atomic claim, executor per action_type, idempotent, rolls back on failure
- Slack approval cards (HMAC-verified) with Approve / Edit buttons
- `/approvals` dashboard view — same engine, lead vs note rendered distinctly
- `decided_by_slack` and `decided_by_user` columns for audit
- **HITL Edit UX shipped** at `/approvals/[id]`:
  - `updatePendingProposal` (save-only) and `approveWithEdits` (save-then-approve) server actions
  - Editor component covers both `create_lead` and `add_note` shapes;
    payload merge preserves source-specific extras (`vapi_call_id`,
    `aurinko_message_id`, `transcript`, `from_email`)
  - Slack "Edit requested" cards now deep-link straight to `/approvals/[id]`
  - Edit button added to `/approvals` cards
- Slack stale-card behavior: dashboard-decided actions don't update the original Slack card (known limitation, needs bot token + `chat.update` for the fix)

### Shared memory layer
- `interactions` table — one row per turn across all channels
- pgvector enabled, HNSW cosine index
- `match_customer_memory` RPC for semantic search
- OpenAI `text-embedding-3-small` (1536 dims, baked into schema)
- `lib/memory.ts` primitives: `recordInteraction`, `recentInteractions`, `searchCustomerMemory`, `recentChannelActivity`
- Best-effort embedding — if OpenAI fails, the row still lands with NULL embedding

### Voice receptionist (Vapi) — code complete
- `/api/vapi/webhook` route with HMAC verification
- End-of-call transcripts ingested into the memory layer (channel=voice)
- Four function tools, all extracted to `lib/vapi-tools.ts`:
  - `capture_lead` — general inquiry → HITL via Slack
  - `propose_booking` — agreed booking → HITL via Slack (status=quoted, structured time)
  - `quote_service` — reads service menu, speaks voice-friendly TTS strings
  - `lookup_customer_history` — recalls customer + cross-channel sync flag
- **Per-shop assistant routing shipped**: `shops.vapi_assistant_id` column,
  webhook resolves shop by `message.call.assistantId`, falls back to
  `VAPI_DEFAULT_SHOP_ID` only as a local-dev escape hatch
- **`/settings` → Voice receptionist card**: paste-the-ID flow with
  webhook URL and secret-status surfaced
- **Go-live doc**: `docs/vapi-go-live.md` covers Vapi dashboard config,
  system prompt copy, exact tool JSON schemas, smoke test, gotchas
- **Still requires** Vapi assistant config + phone number provisioning
  in the Vapi dashboard before it's a real phone line

### Email receptionist (Aurinko) — code complete
- **Inbound shipped** end to end:
  - OAuth start (`/api/aurinko/auth/start`) with HttpOnly state nonce
  - Callback (`/api/aurinko/auth/callback`) exchanges code, fetches
    account, creates `/email/messages` subscription, persists to shop
  - Webhook (`/api/aurinko/webhook`) verifies `X-Aurinko-Signature`
    (HMAC-SHA256 over `v0:{ts}:{body}`, 5-min replay window), resolves
    shop by `accountId`, fetches the message, records interaction
    (channel=email), classifies, drops leads into HITL with Slack card
- Email classifier (`lib/email-classifier.ts`) — Haiku 4.5 +
  structured-output zod schema; returns `is_lead` + extracted
  customer/phone/vehicle/service/summary
- `findOrCreateCustomer` auto-dedup by email; outbound copies are
  filtered by matching sender vs. `aurinko_account_email`
- `/settings` → Email receptionist card: Connect Gmail / Connected /
  Disconnect; surfaces all 8 callback error states as toasts
- **Go-live doc**: `docs/aurinko-go-live.md` covers Aurinko app creation,
  redirect URIs, env vars, smoke test, gotchas, known limitations
- **Still requires** creating the Aurinko app, dropping
  `AURINKO_CLIENT_ID/SECRET/SIGNING_SECRET` into Vercel env, then
  Connect Gmail from the in-app UI

### Gradia Whisper (voice-to-action)
- Mobile mic button on dashboard (`<WhisperButton />`)
- `/api/whisper/process` — OpenAI Whisper transcribes → Claude classifies intent → pending_action → Slack
- Two intent types: `create_lead` and `add_note`
- Smart MIME detection for cross-browser (webm / mp4 / ogg)

### Dashboard surfaces
- `/dashboard` — overview + Whisper button + AI lead section + live lead feed
- `/leads` — full lead table
- `/approvals` — pending HITL items, now with Edit deep-link to `/approvals/[id]`
- `/approvals/[id]` — full HITL revision editor (lead + note variants)
- `/settings` — real surface with Voice + Email integration cards
- `/schedule` — still placeholder, but holding copy now names the missing piece (Google Calendar)
- **Copy polish pass shipped**: dashboard surfaces refreshed through the
  HUMAN.md voice — `we/us` everywhere, warmer empty states, no
  engineering-talk leaking into customer-facing copy

### Tooling state
- `npm run build` clean
- `tsc --noEmit` clean
- ESLint clean
- `next.config.ts` allows ngrok hosts for mobile testing
- 16 migrations applied (or pending apply) to remote Supabase (all idempotent)

---

## Pending integrations (Phase 1 roadmap)

| Integration | Status | Why it matters |
|---|---|---|
| Aurinko (Gmail) — inbound | **code complete, awaits app creation** | Email lead capture — done in code; Aurinko app + env vars left |
| Aurinko (Gmail) — outbound | not started | Nurture sequences, quote replies, confirmations, review requests. Scopes already requested, no UI/HITL wrapper yet |
| Twilio SMS | not started | <1 min lead response, reminders, follow-ups. Biggest unbuilt channel |
| Google Calendar | not started | Bookings need a real calendar surface; gates `/schedule` becoming real |
| Stripe | not started | Whisper "charge Smith $450" + invoicing |
| HubSpot / Jobber | not started | CRM sync — push leads, statuses |
| Meta DMs | not started | Instagram + Facebook lead capture (Phase 3 stretch) |

**Scope decision (2026-05-11):** Outbound voice (Vapi-driven outbound calls
for nurture) removed from the roadmap. Outbound email replaces it as
the nurture channel. Inbound voice (Vapi receptionist) stays in scope.

---

## Pending product work

- ~~Per-shop Vapi assistant routing~~ ✓ shipped 2026-05-12
- Vapi assistant config in their dashboard + phone number provisioning — to actually go live as a receptionist (doc shipped, action on operator)
- `book_appointment` as a real action type → `/schedule` UI gets a real calendar (gated on Google Calendar)
- ~~`/leads/pending/[id]` editor (HITL revision UX for the Edit button)~~ ✓ shipped at `/approvals/[id]` 2026-05-12
- `/customers` view (browse / merge)
- Cross-channel sync flag in the dashboard UI (the `recentChannelActivity` primitive exists)
- Slack stale-card fix (bot token + `chat.update`)
- ~~Real `/settings` page~~ ✓ shipped 2026-05-12 (Voice + Email integration cards)
- ~~UI/UX polish pass~~ ✓ shipped 2026-05-12 (copy + empty-state refresh, voice/visual redesign still queued for a deeper pass)
- BI chat (Phase 2)
- Agent Builder + Co-owner chat surfaces (Phase 2)

---

## Architecture decisions

### Direct integration over MCP for Phase 1
We've built every integration as direct API calls — Supabase JS client, Anthropic SDK, OpenAI REST, Slack webhooks, Vapi webhooks, Aurinko REST + webhooks. This is the right pattern for app-driven flows (HITL approvals, dashboard CRUD).

**MCP servers are a Phase 2 build**, needed once Gradia becomes genuinely agentic (Builder / Co-owner / BI chat personas). See `docs/mcp-architecture.md` for the target architecture and per-persona tool maps.

The critical Phase 2 piece is the **Gradia Internal MCP** wrapping our domain primitives (`proposeLead`, `findCustomerByChannel`, `recordInteraction`, etc.) so Claude can't bypass HITL / dedup / memory by going to raw Supabase MCP.

### Multi-tenant secrets are not yet built
When Stripe / Twilio / Meta land, each shop needs encrypted per-shop OAuth tokens with refresh flow. **Aurinko shipped with plaintext token storage on the shop row** (`aurinko_access_token`) as a deliberate pilot-scope tradeoff. This is a real architectural body of work — roughly a week on its own — and gates true per-shop self-serve onboarding for these channels.

---

## Immediate next step (operator action)

1. **Apply the two new migrations** (`supabase db push`):
   - `20260512100000_shop_vapi_assistant_id.sql`
   - `20260512110000_shop_aurinko.sql`
2. **Vapi go-live** — follow `docs/vapi-go-live.md` to take voice live as a real phone number.
3. **Aurinko go-live** — follow `docs/aurinko-go-live.md` to create the app, drop env vars in Vercel, then Connect Gmail in `/settings`.

After those, the headline pitch — "voice + email + Whisper into one HITL brain" — is true on a real phone number with a real inbox.

## Next engineering (priority order)

1. **Twilio SMS** — biggest unbuilt Phase 1 channel; <1 min lead response is in the brief.
2. **Google Calendar + `book_appointment` action type** — turns `/schedule` from placeholder into a real surface; turns voice/email "booked" status into a real time slot.
3. **Outbound email** — Aurinko's `Mail.Send` scope is already authorized; needs UI + HITL wrapper for replies and nurture.
4. **Stripe + advanced Whisper** — unlocks the "charge Smith $450 and book a follow-up" demo. Depends on (2) for the booking side.
5. **Multi-tenant secrets infrastructure** (~1 week) — required before self-serve onboarding for >1 pilot shop.

Phase 2 (Heat Score, BI chat, Agent Builder, deep CRM push) opens up after the channel layer is complete.

---

## Since the 2026-05-11 snapshot

Code-complete work landed today (2026-05-12), pushed or pending push:

- Per-shop Vapi assistant routing (migration, webhook lookup change, settings UI, env fallback documented)
- Vapi go-live operator doc (`docs/vapi-go-live.md`)
- Aurinko inbound email end-to-end: OAuth, webhook with HMAC verification, Claude classifier, HITL plumbing, settings UI, operator doc
- HITL Edit UX at `/approvals/[id]`: save + save-and-approve + discard, deep-linked from Slack edit cards
- Dashboard copy polish through HUMAN.md voice
