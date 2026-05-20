# Instagram DMs Go-Live Checklist

Code side is done — webhook receiver, X-Hub-Signature-256
verification, classifier, HITL plumbing, encrypted page-access-token
storage, settings UI. This is what you set up on Meta's side.

**Scope: inbound only.** Outbound DM replies (and the auto-draft
that mirrors our SMS/email pattern) are a deliberate follow-up.

---

## 0. Prerequisites

- [ ] Migration `20260519130000_shop_instagram.sql` applied
      (`supabase db push`).
- [ ] Latest code deployed to Vercel.
- [ ] An Instagram **Business** or **Creator** account (personal IG
      accounts can't receive DM webhooks).
- [ ] A Facebook Page linked to that IG account. Yes, you have to
      maintain a FB Page even if you only operate on IG — Meta's
      Messenger Platform routes events by Page ID.

---

## 1. Create a Meta App

1. Go to <https://developers.facebook.com/apps>, **Create App**.
2. Use case: **Business**.
3. Add the **Instagram** product → **Messenger API for Instagram**.
4. From **App Settings → Basic**, grab:
   - **App Secret** → `META_APP_SECRET`

---

## 2. Set Vercel env vars

```
META_APP_SECRET=<from step 1>
META_WEBHOOK_VERIFY_TOKEN=<any strong random string>
```

Generate the verify token with `openssl rand -hex 32` — it's just a
shared secret Meta uses to confirm we own the webhook. Same value
goes in step 3.

**Redeploy** after saving so the build picks up the env.

---

## 3. Subscribe the page to our webhook

In your Meta App dashboard → **Webhooks → Instagram (or Page)**:

- **Callback URL:** `https://gradia-ai-platform.vercel.app/api/meta/webhook`
- **Verify token:** the same value as `META_WEBHOOK_VERIFY_TOKEN`
- **Subscribed fields:** `messages`, `messaging_postbacks` at
  minimum. (Story replies / reactions can come later.)

When you click **Verify and save**, Meta hits our `GET` handler with
`hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. We compare
the token to our env, echo the challenge back if it matches, and
Meta marks the subscription active.

Then **subscribe your specific Page** to the configured fields under
**Webhooks → Page → Add subscription**.

---

## 4. Grab the credentials and paste into `/settings`

You need three things from the Meta developer dashboard:

1. **Facebook Page ID** — the numeric id of the FB Page linked to
   your IG Business Account. Visible in **Page → About** or via
   Graph API Explorer (`GET /me/accounts`).
2. **Instagram Business Account ID** — also visible from Graph API
   Explorer with `?fields=instagram_business_account{id}`.
3. **Page Access Token** — generated via Graph API Explorer with
   the `pages_messaging`, `instagram_basic`,
   `instagram_manage_messages` scopes. **Use a long-lived token**
   (exchange the short-lived one — see Meta's token-exchange docs).

In Gradia: `/settings → Instagram DMs` → paste the three values,
optionally add the `@` handle for display purposes, **Connect**. We
encrypt the token at rest with the same key as the Aurinko token.

---

## 5. App Review (production)

For the `instagram_manage_messages` permission, Meta requires App
Review before any non-tester account can authorize your app. While
in development mode, the only IG accounts your webhook can receive
from are accounts added as **Testers / App Roles** in the Meta App
dashboard.

For the pilot — add yourself and the shop owner as testers. App
review is a separate workstream once we have multi-shop ambition.

---

## 6. Smoke test

From a **different** IG account (one not connected to our app) that's
been added as a tester, DM the shop's IG account with a real-sounding
inquiry:

> *"Hey, do you do ceramic coating on a Tesla? Looking to get one
> done in the next couple weeks."*

Expected:
1. Meta POSTs `/api/meta/webhook` within a few seconds.
2. Signature verifies, shop resolves by Page ID, customer record
   gets created/deduped by sender id (we don't get the @handle in
   the webhook payload — Meta gives a scoped sender id instead).
3. Interaction lands with `channel = instagram`.
4. Classifier marks it as a lead → pending_action created with
   `source: "instagram"`.
5. Slack approval card lands. Approve → lead lands in `/leads`.

Short follow-ups in an established thread ("k", "👍", "thanks") are
filtered out by the classifier — no spam approvals.

---

## 7. Common gotchas

| Symptom | Cause |
|---|---|
| Webhook subscribe step fails with "Could not verify token" | `META_WEBHOOK_VERIFY_TOKEN` mismatch between Meta dashboard and Vercel env. |
| Webhook returns **401 Invalid signature** | `META_APP_SECRET` mismatch — Meta signs every payload with this. |
| Webhook returns **200 but no lead lands** | Page ID didn't match any shop. Re-check `/settings` shows Connected with the right Page ID. |
| No webhook events fire at all | The Page wasn't subscribed under **Webhooks → Page → Add subscription** (the App-level subscription isn't enough — you also need the Page-level one). |
| DMs from outside accounts ignored | App is in development mode; add the sender as a tester, or submit for App Review. |
| Customer record shows opaque ID instead of @ handle | We don't fetch handles from Meta's Graph API in this chunk. Pasting the `@` in the settings card sets the shop's own handle; per-customer handles need a Graph API lookup we haven't built yet. |

---

## 8. Known limitations (pilot scope)

- **Inbound only.** Outbound DM replies + auto-drafts are a follow-up.
- **No handle resolution.** We store the page-scoped sender id; the
  `@` handle requires an extra Graph API call per first contact. Easy
  add once we want better UX.
- **No story reactions / quick-reply postbacks.** We listen for `messages`
  only. Other event types ack with 200 and ignore.
- **One Meta App across shops.** App-level rate limits apply globally.
  Fine at pilot scale; revisit if we cross dozens of shops.
- **No App Review yet.** Until then, only accounts you've explicitly
  added as testers can DM through to us.

---

## 9. After go-live

Next on the engineering side:

1. **Outbound DM replies (HITL)** — extend the `send_*` action family
   with `send_instagram_dm`, draft via Claude, post via Meta's Send API.
2. **Auto-draft IG replies** — sibling of the SMS auto-draft trigger.
3. **Handle resolution** — call Graph API on first contact to
   replace the opaque sender id with the real @ handle.
4. **App Review submission** — required before non-tester accounts
   can DM through.
