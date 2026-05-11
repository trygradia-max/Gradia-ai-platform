# Gradia — Project Status

**Snapshot date:** 2026-05-11
**Phase:** Phase 1 MVP, late stage. Pre-Vercel deploy.

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
- Slack stale-card behavior: dashboard-decided actions don't update the original Slack card (known limitation, needs bot token + `chat.update` for the fix)

### Shared memory layer
- `interactions` table — one row per turn across all channels
- pgvector enabled, HNSW cosine index
- `match_customer_memory` RPC for semantic search
- OpenAI `text-embedding-3-small` (1536 dims, baked into schema)
- `lib/memory.ts` primitives: `recordInteraction`, `recentInteractions`, `searchCustomerMemory`, `recentChannelActivity`
- Best-effort embedding — if OpenAI fails, the row still lands with NULL embedding

### Voice receptionist (Vapi)
- `/api/vapi/webhook` route with HMAC verification
- End-of-call transcripts ingested into the memory layer (channel=voice)
- Four function tools, all extracted to `lib/vapi-tools.ts`:
  - `capture_lead` — general inquiry → HITL via Slack
  - `propose_booking` — agreed booking → HITL via Slack (status=quoted, structured time)
  - `quote_service` — reads service menu, speaks voice-friendly TTS strings
  - `lookup_customer_history` — recalls customer + cross-channel sync flag
- Single-shop dev routing via `VAPI_DEFAULT_SHOP_ID` (per-shop routing is a follow-up)

### Gradia Whisper (voice-to-action)
- Mobile mic button on dashboard (`<WhisperButton />`)
- `/api/whisper/process` — OpenAI Whisper transcribes → Claude classifies intent → pending_action → Slack
- Two intent types: `create_lead` and `add_note`
- Smart MIME detection for cross-browser (webm / mp4 / ogg)

### Dashboard surfaces
- `/dashboard` — overview + Whisper button + AI lead section + live lead feed
- `/leads` — full lead table
- `/approvals` — pending HITL items
- `/schedule`, `/settings` — placeholders (warm copy, no functionality)

### Tooling state
- `npm run build` clean
- `tsc --noEmit` clean
- ESLint clean
- `next.config.ts` allows ngrok hosts for mobile testing
- 14 migrations applied to remote Supabase (all idempotent)

---

## Pending integrations (Phase 1 roadmap, not yet built)

| Integration | Why it matters |
|---|---|
| Aurinko (Gmail) | Email lead capture — biggest unbuilt channel |
| Twilio SMS | <1 min lead response, reminders, follow-ups |
| Google Calendar | Bookings need a real calendar surface |
| Stripe | Whisper "charge Smith $450" + invoicing |
| HubSpot / Jobber | CRM sync — push leads, statuses |
| Meta DMs | Instagram + Facebook lead capture (Phase 3 stretch) |

---

## Pending product work

- Per-shop Vapi assistant routing (`vapi_assistant_id` column + onboarding step)
- `book_appointment` as a real action type → `/schedule` UI gets a real calendar
- `/leads/pending/[id]` editor (HITL revision UX for the Edit button)
- `/customers` view (browse / merge)
- Cross-channel sync flag in the dashboard UI (the `recentChannelActivity` primitive exists)
- Slack stale-card fix (bot token + `chat.update`)
- Real `/settings` page
- BI chat (Phase 2)
- Agent Builder + Co-owner chat surfaces (Phase 2)

---

## Architecture decisions

### Direct integration over MCP for Phase 1
We've built every integration as direct API calls — Supabase JS client, Anthropic SDK, OpenAI REST, Slack webhooks, Vapi webhooks. This is the right pattern for app-driven flows (HITL approvals, dashboard CRUD).

**MCP servers are a Phase 2 build**, needed once Gradia becomes genuinely agentic (Builder / Co-owner / BI chat personas). See `docs/mcp-architecture.md` for the target architecture and per-persona tool maps.

The critical Phase 2 piece is the **Gradia Internal MCP** wrapping our domain primitives (`proposeLead`, `findCustomerByChannel`, `recordInteraction`, etc.) so Claude can't bypass HITL / dedup / memory by going to raw Supabase MCP.

### Multi-tenant secrets are not yet built
When Gmail / Stripe / Twilio / Meta land, each shop needs encrypted per-shop OAuth tokens with refresh flow. This is a real architectural body of work — roughly a week on its own — and gates true per-shop self-serve onboarding for these channels.

---

## Immediate next step

Vercel deploy. Vercel project linked to `trygradia-max/Gradia-ai-platform`, env vars copied from `.env.local`, three external configs updated to point at the Vercel URL (Supabase auth redirect, Slack interactivity URL, GRADIA_DASHBOARD_URL env).

After deploy, the build cadence flips: code change → push → auto-deploy → test on phone. No more ngrok dance.

---

## Recent commits (last 10)

```
440d192 chore: allow ngrok hosts as dev origins for mobile testing
ca118bd feat: Gradia Whisper — voice-to-action with HITL gate
1f64824 feat: voice tools — quote_service, propose_booking, lookup_customer_history
30e7152 feat: Vapi voice receptionist webhook
e12c9e6 feat: shared memory layer with pgvector + OpenAI embeddings
8949dd4 chore: warm sidebar sub-label to match HUMAN.md
5e1f660 feat: onboarding wizard for shop + service menu (Business Brain)
a7ce34d feat: /approvals dashboard view + shared approval engine
dd904c6 chore: rename project brief and ignore supabase CLI temp dir
9a7685e feat: HITL approval gate + unified customer identity
```
