# Operator playbook — from signup to all channels live

Written for the shop owner. If you just signed up for Gradia and
want a single page that takes you from "logged in for the first
time" to "every channel is producing leads," this is it.

The honest version: Gradia is the AI office layer. It plugs into
tools you already have (or sign up for) — Vapi for voice, Gmail for
email, Twilio for SMS, Meta for DMs, Stripe for invoicing. Each
integration takes 10–30 minutes the first time. Total runway from
zero to live is about 90 minutes if you knock them out back to
back, or you can do them one at a time over a week.

## What you'll need to bring

| | What | Why | Cost |
|---|---|---|---|
| 1 | A Vapi account ([vapi.ai](https://vapi.ai)) | Phone receptionist | Pay-as-you-go ($0.05/min ballpark) |
| 2 | A Google Workspace email (not free Gmail) | Email + calendar via Aurinko | $6/user/mo from Google |
| 3 | A Twilio account + one phone number | SMS | ~$1/mo per number + per-message |
| 4 | A Stripe account | Invoicing | 2.9% + 30¢ per transaction |
| 5 | A Facebook Page + Instagram Business account (optional) | DMs | Free |

You don't need all of them on day one. Voice + SMS + payments is
the minimum viable "AI receptionist" setup. Email and DMs can
come later.

---

## Step 0 — The 5-minute orientation

After magic-link signup you'll hit the onboarding wizard:

1. **Shop name + location + phone**. The phone here is your shop's
   actual line (what's on the door). Gradia uses it for caller-ID
   on outbound texts and Stripe receipts.
2. **Service menu**. Add 3–10 services with price + duration. The
   voice agent reads these to callers ("ceramic coating is $450,
   runs about 5 hours"). You can skip and come back; the voice
   agent will just say "we'll send you pricing" until the menu
   is filled.
3. **Confirm**. Lands you on the dashboard.

You'll see a welcome modal listing the 5 channels to connect. A
"Setup 0/7" pill in the top right tracks your progress.

---

## Step 1 — Slack (do this first)

Approvals land in Slack. Without it, every proposed lead /
booking / invoice still works — they just sit silently on the
`/approvals` page until you check it. Slack makes Gradia feel
real.

1. In your Slack workspace → **Apps** → **Browse Apps** → create
   a new app **From scratch**. Name it "Gradia."
2. **Incoming Webhooks** → enable → **Add New Webhook** → pick the
   channel (we recommend a dedicated `#gradia-approvals`).
3. Copy the webhook URL (`https://hooks.slack.com/services/...`).
4. **Basic Information** → copy the **Signing Secret**.
5. In Vercel → your Gradia project → **Settings → Environment
   Variables**, add:
   ```
   SLACK_WEBHOOK_URL=<url from step 3>
   SLACK_SIGNING_SECRET=<secret from step 4>
   ```
6. (Optional, recommended) For the "card updates after dashboard
   decisions" feature, also add a bot token:
   - **OAuth & Permissions** → add `chat:write` scope, install the
     app to your workspace
   - Invite the bot to the approvals channel: in Slack, type
     `/invite @Gradia` in the channel
   - Add `SLACK_BOT_TOKEN=xoxb-...` and `SLACK_DEFAULT_CHANNEL_ID=C...`
     (right-click channel → copy channel ID) to env
7. **Redeploy** Vercel — env changes don't apply until next deploy.
8. (Optional) **Interactivity & Shortcuts** → enable, set Request
   URL to `https://YOUR_DOMAIN/api/slack/interactivity`. This is
   what makes the Approve / Edit buttons inside Slack work.

Test: hit the "Add lead" button on `/dashboard`, fill it in, hit
Save. A card should appear in `#gradia-approvals` within a second.

---

## Step 2 — Voice receptionist (Vapi)

Walks through in detail at `docs/vapi-go-live.md`. The short
version:

1. Sign up at [vapi.ai](https://vapi.ai), add a payment method.
2. **Assistants** → create new. Use the system prompt template at
   the bottom of `docs/vapi-go-live.md` (it tells the assistant
   to use Gradia's tools and use we/us tone).
3. **Tools** → declare the 5 tools (`capture_lead`,
   `propose_booking`, `quote_service`, `lookup_customer_history`,
   `lookup_shop_policy`). The JSON for each is in `vapi-go-live.md`.
4. **Phone Numbers** → buy a number (or import an existing one),
   assign it to the assistant.
5. **Server URL** (under the assistant): paste
   `https://YOUR_DOMAIN/api/vapi/webhook`. Add a **Webhook Secret**
   — copy it into Vercel as `VAPI_WEBHOOK_SECRET` and redeploy.
6. In Gradia → `/settings` → **Voice receptionist** card, paste
   the **Assistant ID** (from Vapi → Assistants list).

Test: call your new Vapi number. Say "I'd like to book a detail
for my Tesla on Saturday at 2pm." A booking proposal should land
in `#gradia-approvals` within 30 seconds of you hanging up.

**Expected time:** 30 minutes the first time. ~$0.05/min in
Vapi costs while you're testing.

---

## Step 3 — Email + Calendar (Aurinko)

`docs/aurinko-go-live.md` for full detail. The catch: Aurinko's
free tier requires a Google Workspace account (paid Google) for
testing. Free Gmail doesn't work.

1. Sign up at [aurinko.io](https://aurinko.io). Create an app.
2. Set the redirect URI to
   `https://YOUR_DOMAIN/api/aurinko/auth/callback`.
3. Request scopes: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`,
   `Calendar.ReadWrite`.
4. Copy **Client ID**, **Client Secret**, and **Signing Secret**
   into Vercel env:
   ```
   AURINKO_CLIENT_ID=...
   AURINKO_CLIENT_SECRET=...
   AURINKO_SIGNING_SECRET=...
   ```
   Redeploy.
5. In Gradia → `/settings` → **Email receptionist** → **Connect
   Gmail**. You'll be redirected through Google OAuth. Land back
   with a green Connected pill.
6. Calendar connects automatically — same OAuth covers both. The
   `/schedule` page will start showing your Google Calendar
   events.

Test: email yourself a fake inquiry from a different account
("Hi, looking for ceramic coating on a 2022 Tesla"). A lead +
draft reply card should appear in Slack.

**Expected time:** 20 minutes if Google Workspace is already set
up; 24-48 hours if you have to wait for DNS propagation on a new
Workspace domain.

---

## Step 4 — SMS (Twilio)

`docs/twilio-go-live.md` for detail. Two modes:

**Pilot mode** — use Gradia's global Twilio account for testing.
Email us your shop ID and we'll provision a number for you.

**BYO mode (recommended past pilot)** — your own Twilio account.
Independent deliverability + A2P registration + bill.

For BYO:

1. Sign up at [twilio.com/console](https://twilio.com/console).
2. **Phone Numbers → Buy a Number** in your area code.
3. On that number's config page, set **A Message Comes In** webhook
   to `https://YOUR_DOMAIN/api/twilio/sms`, method POST.
4. Set **Status Callback URL** (on the same number's messaging
   settings) to `https://YOUR_DOMAIN/api/twilio/sms/status?shop=<your shop id>`.
   Get your shop ID from `/settings` → URL bar or contact us.
5. Copy **Account SID** and **Auth Token** from the console
   homepage.
6. In Gradia → `/settings` → **SMS receptionist**:
   - Paste your Twilio number in E.164 (e.g. `+15551234567`) and
     Save.
   - Below that, paste your **Account SID** + **Auth Token** in
     the "Use your own Twilio account" section and Save.

Test: text your Twilio number "Hi, looking for a quote on a
Tesla detail." Should get a draft reply card in Slack within a
few seconds.

**Expected time:** 15 minutes for BYO. A2P 10DLC registration
(required for production SMS to US numbers) takes 1-2 weeks
separately.

---

## Step 5 — Payments (Stripe)

`docs/stripe-go-live.md` for detail. Uses Stripe Connect Standard
— Gradia never sees your raw secret key.

1. Sign up at [stripe.com](https://stripe.com), complete the
   basic onboarding (bank account, EIN, etc.).
2. Tell us (Gradia) your shop ID — we set you up as a Connect
   platform account on our side. (Operator handles this; one-time.)
3. In Gradia → `/settings` → **Payments** → **Connect Stripe**.
   You'll be redirected through Stripe's hosted onboarding (asks
   for identity verification + bank routing).
4. Land back with green "Connected" + "charges enabled" pills.
5. **Stripe webhook**: in your Stripe Dashboard → **Developers →
   Webhooks → Add endpoint**, set URL to
   `https://YOUR_DOMAIN/api/stripe/webhook`. Listen to **events on
   connected accounts** for: `invoice.paid`,
   `invoice.payment_failed`, `charge.refunded`. Copy the signing
   secret → Vercel env as `STRIPE_WEBHOOK_SECRET`. Redeploy.

Test: from the dashboard's Whisper button, say "charge Smith $450
for ceramic coating." A charge proposal should appear in Slack.
Approve it; the customer gets an emailed invoice. Pay it (use a
Stripe test card if you're testing) and watch the dashboard
revenue tile tick up.

**Expected time:** 25 minutes including Stripe identity check.

---

## Step 6 — DMs (Instagram + Facebook)

`docs/meta-go-live.md` for detail. Optional but useful if you
get DMs from prospects.

1. At [developers.facebook.com](https://developers.facebook.com),
   create a new app. Type: **Business**.
2. Add the **Messenger** + **Instagram** products.
3. Subscribe your Facebook Page to the webhook
   `https://YOUR_DOMAIN/api/meta/webhook` for events: `messages`,
   `messaging_postbacks`.
4. Set the verify token to anything strong; copy it into Vercel
   as `META_WEBHOOK_VERIFY_TOKEN`.
5. Copy the App Secret into Vercel as `META_APP_SECRET`. Redeploy.
6. Generate a long-lived **Page Access Token** with scopes:
   `pages_messaging`, `pages_show_list`,
   `instagram_basic`, `instagram_manage_messages`.
7. In Gradia → `/settings`:
   - **Instagram DMs** card: paste FB Page ID, IG Business
     Account ID, optional @handle, Page Access Token.
   - **Facebook DMs** card: paste FB Page ID and Page Access
     Token (often the same token works for both).

Test: DM your Instagram business account from another account
("Looking for paint correction on a black Audi"). Should appear
as a lead + draft reply card in Slack.

**Expected time:** 30-45 minutes the first time. Meta's developer
console is the most annoying of the bunch.

---

## Step 7 — Jobber (optional, if you use it)

`docs/jobber-go-live.md` for detail. Only relevant if you already
use Jobber for invoicing/scheduling.

1. At [developer.getjobber.com](https://developer.getjobber.com),
   create a new app. Set redirect to
   `https://YOUR_DOMAIN/api/jobber/auth/callback`.
2. Request scopes: read/write × clients/requests/quotes.
3. Copy Client ID + Secret into Vercel env as `JOBBER_CLIENT_ID`
   + `JOBBER_CLIENT_SECRET`. Redeploy.
4. In Gradia → `/settings` → **Jobber** → **Connect Jobber**.

Once connected: every approved lead and booking pushes to Jobber
as a Client + Request automatically. Mirrored client/request IDs
land on the customer detail page so you can confirm the sync.

---

## Step 8 — Shop knowledge (RAG)

Make the drafters smart about your shop.

1. `/settings` → scroll to **Shop knowledge**.
2. Paste 5-10 entries:
   - Deposit policy
   - Weather cancellation policy
   - What services you DON'T do
   - Brand voice notes ("we say 'our' not 'your', etc.")
   - Pricing for common services
3. For longer docs (full brand guide, pricing sheet), the form
   auto-chunks anything over ~4,000 chars. Just paste; it'll
   show "Will split into N chunks" and you click save.

Once knowledge is there, every SMS / email / IG / FB auto-reply
+ the voice agent's `lookup_shop_policy` tool will cite from it
instead of inventing things.

---

## What "all channels live" looks like

When the setup pill in your header reads **"All channels live"
✓**:

- `/dashboard` shows the co-owner widget (proactive nudges),
  channel card (all green), revenue tiles, AI lead section, live
  lead feed.
- Real inquiries from voice/email/SMS/IG/FB all funnel into
  `#gradia-approvals` as one-tap-approve cards.
- `/schedule` shows your Google Calendar.
- `/customers/[id]` shows every touchpoint across every channel
  for a given customer, with "Synced to Jobber" if applicable.
- `/chat` answers any question about your business with grounded
  citations.

Total operator effort to maintain: about 5 minutes a day reviewing
approvals on your phone in the bay.

---

## When something breaks

- **Slack cards stopped appearing** — check `/approvals` directly.
  If items are there, your webhook is misconfigured or the channel
  is wrong. If items aren't there, the inbound webhook isn't
  reaching us — check the integration's webhook config.
- **"Aurinko not connected" error after months of use** — your
  token may have expired. With the self-refresh fix shipped
  2026-05-22, this should be automatic. If it still happens,
  Disconnect + Reconnect from `/settings`.
- **A Twilio send fails with 401** — your auth token changed on
  Twilio's side. Update it in `/settings` → **SMS receptionist**
  → **Use your own Twilio account**.
- **Sentry alerts go quiet** — check `SENTRY_DSN` is set on
  Vercel; without it, error monitoring no-ops cleanly.
- **Anything else** — `docs/project-status.md` lists known
  limitations + the "since last snapshot" log so you can sanity-
  check what's expected vs broken.
