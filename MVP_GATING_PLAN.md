# Gradia MVP Re-scope — Feature Gating Plan

_Last updated: 2026-06-01_

This is the canonical plan for trimming the current build down to the refreshed MVP **without deleting code**. Everything out of scope gets gated behind a single feature-flag config so it stays dormant and reversible. Hand this file to Claude Code as the build spec.

---

## 1. Locked decisions

- **2 agents:** Voice agent + Chat agent. The "Chat agent" = the existing **agentic runtime** (custom-agent builder + hourly cron `/api/cron/agents` + `outbound-email` / `outbound-sms` actions). It runs outreach to old leads and follow-ups on autopilot, with human-in-the-loop approval.
- **2 features:** Gradia Whisper, Agentic mode.
- **3 integrations:** Calendar, CRM (Jobber), Email.
- **Paywall + credit-limit setting:** net new — does not exist yet.
- **Hide:** Instagram, Facebook, and the **Billing agent** (the "charge customers by voice" flow) — plus their settings cards and routes.
- **Mechanism:** Feature flags. One config file is the single source of truth. Nothing is deleted; flip a flag to bring anything back.

---

## 2. Keep / Hide / Build map

### Keep visible (in MVP)

| Surface | Where it lives |
|---|---|
| Voice agent | `src/lib/data/agents.ts` → `voice` |
| Chat agent (agentic runtime) | agent builder `/agents/build`, `src/lib/agent-runtime.ts`, `/api/cron/agents`, `outbound-email.ts`, `outbound-sms.ts` |
| Email agent + Email integration | `email` agent, `EmailSettingsCard`, Aurinko routes |
| SMS agent + Twilio | `sms` agent, `SmsSettingsCard`, `/api/twilio/*` — kept as the follow-up channel |
| Booking agent + Calendar | `booking` agent, Aurinko calendar |
| CRM | `JobberSettingsCard`, `/api/jobber/*` |
| Memory + Ask Gradia BI chat | `memory` agent, `/chat`, `/api/bi/chat` |
| Whisper | `/api/whisper/process` (repoint — see §5) |
| Knowledge + Developer/MCP settings | `KnowledgeSettingsCard`, `McpTokensCard` |

### Hide (gate off — code stays)

| Surface | Files to gate |
|---|---|
| Instagram DM agent | `src/lib/data/agents.ts` → `instagram` |
| Billing agent | `src/lib/data/agents.ts` → `billing` |
| Instagram settings card | `settings/page.tsx` → `InstagramSettingsCard` + `instagram` section |
| Facebook settings card | `settings/page.tsx` → `FacebookSettingsCard` + `facebook` section |
| Payments (Stripe Connect, customer charges) | `settings/page.tsx` → `StripeSettingsCard` + `payments` section |
| Meta routes | `/api/meta/auth/start`, `/api/meta/auth/callback`, `/api/meta/webhook` |
| Stripe Connect routes (customer billing) | `/api/stripe/connect/start`, `/api/stripe/connect/return` |
| Outbound actions | `outbound-facebook.ts`, `outbound-instagram.ts`, `meta-oauth.ts`, `stripe-connect.ts` |

> **Do not gate** `/api/stripe/webhook` — the new subscriber paywall will reuse Stripe and likely this webhook. Keep it live.

### Build (net new)

- **Subscriber paywall** — gates app access behind a paid plan. This is *Stripe Checkout/Billing for the detailer's subscription*, separate from the hidden Stripe Connect (which charged the detailer's *customers*).
- **Credit-limit setting** — per-shop cap on agent actions/spend, enforced in the agent runtime before each run.

---

## 3. The flag spine

Create **`src/lib/features.ts`** as the single source of truth:

```ts
// Single source of truth for what ships in the MVP.
// Gate, don't delete. Flip a value to true to bring a surface back.
export const FEATURES = {
  agents: {
    voice: true,
    chat: true,      // the agentic runtime
    email: true,
    sms: true,
    booking: true,
    memory: true,
    instagram: false, // hidden
    billing: false,   // hidden
  },
  integrations: {
    calendar: true,
    crm: true,        // Jobber
    email: true,
    sms: true,
    instagram: false, // hidden
    facebook: false,  // hidden
    payments: false,  // Stripe Connect customer billing — hidden
  },
  whisper: true,
  agenticMode: true,
  biChat: true,       // Ask Gradia
  paywall: true,      // new
} as const

export type AgentId = keyof typeof FEATURES.agents
export const agentEnabled = (id: string): boolean =>
  (FEATURES.agents as Record<string, boolean>)[id] ?? false
export const integrationEnabled = (id: string): boolean =>
  (FEATURES.integrations as Record<string, boolean>)[id] ?? false
```

Optionally back each value with a `NEXT_PUBLIC_FEATURE_*` env var later if you want per-environment control (staging shows more than prod). Start with the static config.

---

## 4. Where each flag is enforced (3 layers)

**Layer 1 — Agent catalog filter.** In `src/lib/data/agents.ts`, the `buildAgents(shop)` return array is filtered by the flag before it leaves the function:

```ts
import { agentEnabled } from "@/lib/features"
// ...at the end of buildAgents:
return [ /* all 7 agents */ ].filter((a) => agentEnabled(a.id))
```

One line removes Instagram + Billing from the `/agents` page, the counts in the header, and anywhere else that reads the catalog.

**Layer 2 — Settings cards.** In `src/app/(dashboard)/settings/page.tsx`:
- Drop `instagram`, `facebook`, `payments` from the `sections` array (so the section nav hides them).
- Wrap the three `<section>` blocks in `{integrationEnabled("instagram") && ( … )}`, etc.

**Layer 3 — Route guard.** Add `src/middleware.ts` (none exists today) to 404 the hidden API routes so they can't be hit directly even though the files remain:

```ts
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { FEATURES } from "@/lib/features"

const GATED: Array<[string, boolean]> = [
  ["/api/meta", FEATURES.integrations.instagram || FEATURES.integrations.facebook],
  ["/api/stripe/connect", FEATURES.integrations.payments],
]

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  for (const [prefix, enabled] of GATED) {
    if (pathname.startsWith(prefix) && !enabled) {
      return new NextResponse("Not found", { status: 404 })
    }
  }
  return NextResponse.next()
}

export const config = { matcher: ["/api/:path*"] }
```

**Nav:** the sidebar (`app-sidebar.tsx`) has no Instagram/Billing entries today, so nothing to hide there. Ask Gradia stays.

---

## 5. Whisper repoint

The Billing agent is hidden, but **Whisper stays** (`/api/whisper/process`). Today Whisper's intent handler feeds the "charge Smith $450" Stripe-invoice flow. Repoint it: keep transcription + intent parsing, but route the output to **voice-note → memory / lead capture** instead of Stripe. Put the Stripe-invoice branch behind `FEATURES.agents.billing` so it's dormant, not deleted.

---

## 6. Scoped `CLAUDE.md` (keeps the build on point)

Drop this at the repo root so Claude Code respects MVP scope and doesn't wander into dormant code:

```md
# Gradia — MVP scope (read before editing)

The MVP is: 2 agents (Voice, Chat), 2 features (Whisper, Agentic mode),
3 integrations (Calendar, CRM/Jobber, Email), plus a subscriber paywall + credit limit.

## Source of truth
`src/lib/features.ts` decides what ships. Anything set to `false` is intentionally
dormant — GATE it, never delete it. We are keeping this code for later.

## Do not surface or modify (dormant)
- Instagram + Facebook agents and `/api/meta/*` routes
- Billing agent (customer charge-by-voice) and `/api/stripe/connect/*`
- `outbound-facebook.ts`, `outbound-instagram.ts`, `meta-oauth.ts`, `stripe-connect.ts`

## Keep `/api/stripe/webhook` live — the paywall reuses it.

## When adding a feature, add its flag to features.ts first, then gate UI + routes + actions.
```

---

## 7. Build order

1. Add `src/lib/features.ts`.
2. Filter the catalog in `src/lib/data/agents.ts` (Layer 1).
3. Gate the three settings cards + `sections` array (Layer 2).
4. Add `src/middleware.ts` route guard (Layer 3).
5. Repoint Whisper off the billing flow (§5).
6. Add root `CLAUDE.md` (§6).
7. **Then, as a separate workstream:** build the subscriber paywall + credit-limit setting.

Steps 1–6 are the "hide" pass and are low-risk/reversible. Step 7 is net-new feature work.

---

## 8. Verification

- `npm run build` passes clean.
- `/agents` shows the kept agents only — **no Instagram, no Billing** card, and the header count matches.
- `/settings` shows no Instagram / Facebook / Payments sections.
- Direct-hitting `https://<app>/api/meta/webhook` returns **404**.
- Flip `FEATURES.agents.instagram` back to `true` → the Instagram agent reappears with no other change. (Proves the gate is reversible, not destructive.)

---

## Open item

Confirm this GitHub clone is canonical before executing. Earlier notes flagged a separate "live" copy on the Desktop; if it has uncommitted work, reconcile it into `main` first so we don't gate against stale code.
