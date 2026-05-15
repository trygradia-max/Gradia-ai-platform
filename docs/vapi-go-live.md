# Vapi Go-Live Checklist (Pilot Shop)

Everything you need to do in the Vapi dashboard to take Gradia's voice
receptionist from "backend ready" to "you can call this number." Code
side is done — the webhook routes calls per shop via
`shops.vapi_assistant_id`.

---

## 0. Prerequisites

- [ ] Migration `20260512100000_shop_vapi_assistant_id.sql` applied to
      remote Supabase (`supabase db push` or paste in dashboard).
- [ ] Latest code deployed to Vercel (`git push` to `main`).
- [ ] `VAPI_WEBHOOK_SECRET` set in Vercel env (any strong random string
      — generate with `openssl rand -hex 32`).
- [ ] `VAPI_DEFAULT_SHOP_ID` removed/blank in Vercel env (this was the
      single-shop dev fallback — per-assistant routing replaces it).
- [ ] `SLACK_WEBHOOK_URL` and `SLACK_SIGNING_SECRET` already set
      (status doc confirms these are live).

---

## 1. Create the Vapi assistant

In the Vapi dashboard → **Assistants** → **Create Assistant**.

### Model
- Provider: **Anthropic**
- Model: **Claude Sonnet 4.6** (`claude-sonnet-4-6`)
  - Reason: fast enough for phone latency, strong tool calling, on-brand
    warmth without prompt acrobatics. Haiku 4.5 is the budget fallback;
    Opus is overkill for receptionist work.

### Transcriber
- Provider: **Deepgram**
- Model: **nova-2** (or **nova-3** if available in your region)
- Language: **en-US**

### Voice
- Provider: **11labs** (or Vapi's built-in if cost matters more than
  warmth)
- Pick a voice that sounds friendly and clear — test a few. Avoid the
  default "monotone professional" ones; we want warm partner energy.

### First message
> "Hey, this is Gradia from {{shop.name}} — how can we help today?"

(Replace `{{shop.name}}` with the actual shop name.)

### System prompt
Paste this verbatim, then swap `{{shop.name}}` for the real shop name
(e.g. "Apex Detailing"):

```
You are Gradia — the AI partner and receptionist for {{shop.name}}, an auto detailing shop. Speak as "we" and "us", never "you and I". You are warm, confident, specific, and brief.

How we work:
- Greet callers as Gradia from {{shop.name}}.
- Ask one focused question at a time. Phone calls move fast — never overwhelm.
- For known callers, use lookup_customer_history at the start to recall context. If they've reached out on another channel recently, mention it warmly ("Heads up — we also got your email earlier today").
- For pricing, use the quote_service tool. NEVER quote a price you didn't pull from the tool. If a service isn't on our menu, say so and offer the closest thing we do.
- For general inquiries, capture name + phone and use capture_lead.
- For agreed bookings, confirm the service and time, then use propose_booking. When you call it, fill `iso_start_time` with the agreed time as a real ISO datetime so we can put it on our calendar — never skip this if the caller has named a specific day and time. Always say "we'll confirm shortly and text you the details" — never promise the booking is final. Our team reviews every request before it's locked in.
- If anything is unclear (missing name, vague time, off-topic), ask one short clarifying question.
- Keep replies under two sentences when possible.

Boundaries:
- If the request is outside auto detailing (towing, mechanic work, etc.), politely redirect.
- Don't invent services, promotions, hours, or staff names. If unsure, say "let me have someone follow up on that."
- Never tell a caller the booking is confirmed — only that we'll confirm shortly.
```

### Server URL (this is the bridge into Gradia)
- URL: `https://gradia-ai-platform.vercel.app/api/vapi/webhook`
- Secret: paste the same value as `VAPI_WEBHOOK_SECRET` in Vercel.
  Vapi sends it as the `x-vapi-secret` header; webhook does a
  timing-safe compare.

### Server events
At minimum, enable:
- `function-call`
- `end-of-call-report`

Everything else (status updates, transcript chunks) is fine to leave
on — the webhook acknowledges and ignores them.

---

## 2. Declare the 4 tools

Vapi calls these "functions." Add each one in the assistant's **Tools
/ Functions** section. Names must match exactly — the webhook
dispatches by `functionCall.name`.

### `capture_lead`
General inquiry — name + phone, optional vehicle/service/notes.

```json
{
  "name": "capture_lead",
  "description": "Log a general inquiry from a caller. Use when the caller wants info or a callback but hasn't agreed to a specific booking yet.",
  "parameters": {
    "type": "object",
    "properties": {
      "customer_name": { "type": "string", "description": "Caller's full name" },
      "phone":         { "type": "string", "description": "Best callback phone number" },
      "vehicle":       { "type": "string", "description": "Make, model, year if mentioned" },
      "service":       { "type": "string", "description": "What service they asked about" },
      "notes":         { "type": "string", "description": "Anything else worth flagging" }
    },
    "required": ["customer_name"]
  }
}
```

### `propose_booking`
Agreed-upon booking — service + when are required. When `iso_start_time` is set, the approval engine creates a real calendar event on the connected Google Calendar; otherwise it falls back to a quoted lead so a human can pin down the time.

```json
{
  "name": "propose_booking",
  "description": "Log an agreed-upon booking request. Use only when the caller has agreed on what service and when. Our team confirms before it's locked in. Always fill iso_start_time when you can convert the caller's spoken time into an ISO datetime — it's what lets us put it on the calendar.",
  "parameters": {
    "type": "object",
    "properties": {
      "customer_name":    { "type": "string", "description": "Caller's full name" },
      "phone":            { "type": "string", "description": "Best callback phone number" },
      "service":          { "type": "string", "description": "Service from our menu" },
      "when":             { "type": "string", "description": "Caller's natural-language time (e.g. 'Saturday 2pm')" },
      "iso_start_time":   { "type": "string", "description": "Same time as `when` but as a full ISO 8601 datetime (e.g. '2026-05-16T14:00:00-07:00'). Fill this whenever possible." },
      "duration_minutes": { "type": "integer", "description": "Service duration in minutes. If unknown, omit — we'll look it up from the menu." },
      "timezone":         { "type": "string", "description": "IANA timezone name for the shop (e.g. 'America/Los_Angeles')" },
      "vehicle":          { "type": "string", "description": "Make, model, year if mentioned" },
      "notes":             { "type": "string", "description": "Anything else worth flagging" }
    },
    "required": ["customer_name", "service", "when"]
  }
}
```

### `quote_service`
Reads the shop's service menu from Supabase.

```json
{
  "name": "quote_service",
  "description": "Look up pricing and duration from our service menu. Always use this before quoting any price — never guess.",
  "parameters": {
    "type": "object",
    "properties": {
      "service": { "type": "string", "description": "Service name or keyword (e.g. 'ceramic coating', 'interior detail')" }
    },
    "required": ["service"]
  }
}
```

### `lookup_customer_history`
Recalls cross-channel history for a caller.

```json
{
  "name": "lookup_customer_history",
  "description": "Recall recent touchpoints across voice, SMS, email, and social for the caller. Use at the start of the call when the caller's phone is available.",
  "parameters": {
    "type": "object",
    "properties": {
      "phone": { "type": "string", "description": "Caller's phone (defaults to caller ID if omitted)" }
    },
    "required": []
  }
}
```

---

## 3. Provision a phone number

In Vapi dashboard → **Phone Numbers** → **Buy Number** (or **Import**
if porting an existing line). Then **Assign** it to the assistant
created in step 1.

For the pilot, a Twilio-backed Vapi number in the shop's area code is
plenty.

---

## 4. Connect the assistant to Gradia

1. Copy the **Assistant ID** from the Vapi dashboard (top of the
   assistant's settings page).
2. In Gradia, go to **/settings** → **Voice receptionist**.
3. Paste the ID, click **Save**. You should see a green **Connected**
   pill appear.

---

## 5. Smoke test

Call the number from your phone. Walk through this script:

1. **Greeting check** — Gradia should pick up speaking as "we" with
   the shop name.
2. **Pricing check** — "How much is a ceramic coating?"
   - Expect: Gradia calls `quote_service`, reads the price + duration
     from the menu.
3. **Booking check** — "Great, let's book that for Saturday at 2pm.
   My name is [yourname], phone is [number]."
   - Expect: Gradia calls `propose_booking`, says "we'll confirm
     shortly and text you the details."
4. **Slack check** — within a few seconds, a Slack approval card lands
   in the channel pointed at by `SLACK_WEBHOOK_URL`. Approve it.
5. **Dashboard check** — the lead appears in **/leads** with status
   `quoted`. The call transcript is in `interactions` (visible later
   via `/customers` once that view ships).

---

## 6. Common gotchas

| Symptom | Cause |
|---|---|
| Webhook returns **401 Invalid signature** | `VAPI_WEBHOOK_SECRET` mismatch between Vapi and Vercel env. |
| Webhook returns **500 Shop not configured** | Assistant ID not yet saved in `/settings`, and no `VAPI_DEFAULT_SHOP_ID` fallback. |
| Gradia quotes a price that isn't on our menu | System prompt rule was ignored — re-paste the prompt and check `quote_service` is declared. |
| Gradia says the booking is confirmed | System prompt rule was ignored — every booking is a *proposal* until HITL approval. |
| Slack card never arrives | `SLACK_WEBHOOK_URL` blank, or the channel was archived. Test with `curl` first. |
| Call connects but every tool fails silently | Server URL is wrong, or pointing at `localhost` / a stale ngrok. Must be the Vercel URL. |

---

## 7. After go-live

- Per-shop voice numbers are now self-serve via `/settings`. Onboarding
  step for Vapi can stay deferred until we have >1 pilot shop.
- The `VAPI_DEFAULT_SHOP_ID` env var should stay blank in production.
  It's local-dev only now.
- Next channel to wire up: Aurinko inbound email (task #3).
