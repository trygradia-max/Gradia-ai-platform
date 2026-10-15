# Route inventory — 2026-10-09

Branch: `codex/cursor-component-polish`. First visual slice (tokens + Home /
Conversations / Customers) is marked below. Remaining inventory stays
`pending` for later PRs. Keyboard/signed-in Whisper notes live in
`docs/qa/WHISPER_UI_ACCEPTANCE.md`.

`src/app/actions/` is server actions, not a route table.

## App pages

| Route | File | Notes | Status |
| --- | --- | --- | --- |
| `/` | `src/app/page.tsx` | Redirects to `/dashboard`. | pending |
| `/login` | `src/app/login/page.tsx` | Public sign-in. Labelled FormField, 44px targets, field errors. Auth/redirect unchanged. | updated |
| `/onboarding` | `src/app/onboarding/page.tsx` | First-run wizard; outside dashboard gate. Stepper, FormField, 44px actions. Provisioning/billing unchanged. | updated |
| `/how-it-works` | `src/app/how-it-works/page.tsx` | Help article. | pending |
| `/dashboard` | `src/app/(dashboard)/dashboard/page.tsx` | Home. Loading: `dashboard/loading.tsx`. | updated |
| `/approvals` | `src/app/(dashboard)/approvals/page.tsx` | Owner queue. Loading: `approvals/loading.tsx`. | updated |
| `/approvals/[id]` | `src/app/(dashboard)/approvals/[id]/page.tsx` | Proposal detail. Loading: `approvals/[id]/loading.tsx`. | updated |
| `/activity` | `src/app/(dashboard)/activity/page.tsx` | Loading: `activity/loading.tsx`. | updated |
| `/conversations` | `src/app/conversations/page.tsx` | Whisper list. Layout flush shell; `loading.tsx`, `error.tsx`. | updated |
| `/conversations/[customerId]` | `src/app/conversations/[customerId]/page.tsx` | Thread. Same layout/loading/error. | updated |
| `/customers` | `src/app/(dashboard)/customers/page.tsx` | Loading: `customers/loading.tsx`. | updated |
| `/customers/[id]` | `src/app/(dashboard)/customers/[id]/page.tsx` | Loading: `customers/[id]/loading.tsx`. | updated |
| `/customers/quotes/new` | `src/app/(dashboard)/customers/quotes/new/page.tsx` | Header only this slice. Loading: `customers/quotes/new/loading.tsx`. | updated |
| `/customers/recovery` | `src/app/(dashboard)/customers/recovery/page.tsx` | Feature-flagged; else `/dashboard`. Loading: `customers/recovery/loading.tsx`. | pending |
| `/calendar` | `src/app/(dashboard)/calendar/page.tsx` | Loading: `calendar/loading.tsx`. | pending |
| `/receptionist` | `src/app/(dashboard)/receptionist/page.tsx` | Loading: `receptionist/loading.tsx`. | updated |
| `/receptionist/build` | `src/app/(dashboard)/receptionist/build/page.tsx` | Feature-flagged; else `/agents`. Loading: `receptionist/build/loading.tsx`. | pending |
| `/settings` | `src/app/(dashboard)/settings/page.tsx` | Loading: `settings/loading.tsx`. | updated |
| `/billing` | `src/app/billing/page.tsx` | Layout-only; no price/plan changes. | updated |
| `/control-center` | `src/app/control-center/page.tsx` | Loading/error siblings. | updated |
| `/calls/[callId]` | `src/app/(dashboard)/calls/[callId]/page.tsx` | Loading: `calls/[callId]/loading.tsx`. | pending |
| `/team` | `src/app/team/page.tsx` | Own chrome, not AppShell. Loading/error siblings. | updated |
| `/team/approvals` | `src/app/team/approvals/page.tsx` | Delegated message approve/reject. | updated |
| `/team/delivery-reviews` | `src/app/team/delivery-reviews/page.tsx` | Delegated delivery review. | updated |
| `/intake` | `src/app/intake/page.tsx` | Unresolved identity review plus qualification list (`loadLeadQualifications`). TeamChrome, ReviewCard, honest customer search, Pagination. Loading/error siblings. Staff/revoked unavailable. | updated |
| `/intake/[workflowId]` | `src/app/intake/[workflowId]/page.tsx` | Intake history, existing vehicle link, and qualification review/edit (`loadLeadQualification`, `updateLeadQualification`). Same chrome. | updated |
| `/q/[token]` | `src/app/q/[token]/page.tsx` | Public quote. `not-found.tsx`. | pending |

## Redirects (legacy aliases)

| Route | File | Destination | Status |
| --- | --- | --- | --- |
| `/chat` | `src/app/(dashboard)/chat/page.tsx` | `/conversations` | pending |
| `/agents` | `src/app/(dashboard)/agents/page.tsx` | `/receptionist` | pending |
| `/agents/build` | `src/app/(dashboard)/agents/build/page.tsx` | `/receptionist/build` | pending |
| `/agent` | `src/app/(dashboard)/agent/page.tsx` | `/receptionist` | pending |
| `/leads` | `src/app/(dashboard)/leads/page.tsx` | `/customers` | pending |
| `/schedule` | `src/app/(dashboard)/schedule/page.tsx` | `/calendar` | pending |
| `/recovery` | `src/app/(dashboard)/recovery/page.tsx` | `/customers/recovery` | pending |

## Shared boundaries

| File | Role | Status |
| --- | --- | --- |
| `src/app/layout.tsx` | Root HTML. | pending |
| `src/app/error.tsx` | Root error. | pending |
| `src/app/global-error.tsx` | Root fatal. | pending |
| `src/app/not-found.tsx` | Root 404. | pending |
| `src/app/(dashboard)/layout.tsx` | Owner desk `AppShell`. | updated |
| `src/app/(dashboard)/error.tsx` | Dashboard error. | updated |
| `src/app/(dashboard)/not-found.tsx` | Dashboard 404. | pending |
| `src/app/conversations/layout.tsx` | Flush `AppShell`. | updated |
| `src/app/conversations/loading.tsx` | “Loading conversations”. | updated |
| `src/app/conversations/error.tsx` | List/thread error card. | updated |
| `src/app/control-center/loading.tsx` | Control Center loading. | updated |
| `src/app/control-center/error.tsx` | Control Center error. | updated |
| `src/app/team/loading.tsx` | Team loading. | updated |
| `src/app/team/error.tsx` | Team error. | updated |
| `src/app/intake/loading.tsx` | Intake skeleton cards. | updated |
| `src/app/intake/error.tsx` | Intake failed-load card. | updated |
| `src/app/q/[token]/not-found.tsx` | Public quote 404. | pending |
| `src/app/auth/callback/route.ts` | Auth code exchange. | pending |

## API routes

| Route | File | Status |
| --- | --- | --- |
| `/api/admin/alert-test` | `src/app/api/admin/alert-test/route.ts` | pending |
| `/api/admin/margin-report` | `src/app/api/admin/margin-report/route.ts` | pending |
| `/api/agent/chat` | `src/app/api/agent/chat/route.ts` | pending |
| `/api/aurinko/auth/callback` | `src/app/api/aurinko/auth/callback/route.ts` | pending |
| `/api/aurinko/auth/start` | `src/app/api/aurinko/auth/start/route.ts` | pending |
| `/api/aurinko/webhook` | `src/app/api/aurinko/webhook/route.ts` | pending |
| `/api/bi/chat` | `src/app/api/bi/chat/route.ts` | pending |
| `/api/cron/agents` | `src/app/api/cron/agents/route.ts` | pending |
| `/api/cron/automations` | `src/app/api/cron/automations/route.ts` | pending |
| `/api/cron/no-show-ladder` | `src/app/api/cron/no-show-ladder/route.ts` | pending |
| `/api/cron/provider-events-prune` | `src/app/api/cron/provider-events-prune/route.ts` | pending |
| `/api/cron/reconcile` | `src/app/api/cron/reconcile/route.ts` | pending |
| `/api/cron/recovery-retention` | `src/app/api/cron/recovery-retention/route.ts` | pending |
| `/api/cron/reminders` | `src/app/api/cron/reminders/route.ts` | pending |
| `/api/cron/roi-receipt` | `src/app/api/cron/roi-receipt/route.ts` | pending |
| `/api/cron/voice-sync` | `src/app/api/cron/voice-sync/route.ts` | pending |
| `/api/export` | `src/app/api/export/route.ts` | pending |
| `/api/health` | `src/app/api/health/route.ts` | pending |
| `/api/intake/meta-lead-ads` | `src/app/api/intake/meta-lead-ads/route.ts` | pending |
| `/api/intake/public-form/[formId]` | `src/app/api/intake/public-form/[formId]/route.ts` | pending |
| `/api/intake/website-form` | `src/app/api/intake/website-form/route.ts` | pending |
| `/api/jobber/auth/callback` | `src/app/api/jobber/auth/callback/route.ts` | pending |
| `/api/jobber/auth/start` | `src/app/api/jobber/auth/start/route.ts` | pending |
| `/api/mcp` | `src/app/api/mcp/route.ts` | pending |
| `/api/recovery/import` | `src/app/api/recovery/import/route.ts` | pending |
| `/api/recovery/import/[jobId]/extract` | `src/app/api/recovery/import/[jobId]/extract/route.ts` | pending |
| `/api/stripe/connect/return` | `src/app/api/stripe/connect/return/route.ts` | pending |
| `/api/stripe/connect/start` | `src/app/api/stripe/connect/start/route.ts` | pending |
| `/api/stripe/webhook` | `src/app/api/stripe/webhook/route.ts` | pending |
| `/api/twilio/a2p/status` | `src/app/api/twilio/a2p/status/route.ts` | pending |
| `/api/twilio/sms` | `src/app/api/twilio/sms/route.ts` | pending |
| `/api/twilio/sms/status` | `src/app/api/twilio/sms/status/route.ts` | pending |
| `/api/vapi/webhook` | `src/app/api/vapi/webhook/route.ts` | pending |
| `/api/whisper/process` | `src/app/api/whisper/process/route.ts` | pending |

## Reviewable slices

1. Home, Conversations, Customers (tokens + shared wrappers).
2. Approvals, Activity, and delegated `/team/approvals` (ReviewCard +
   honest page-local activity filters).
3. Team, delivery reviews, Settings, Control Center, receptionist, and
   billing layout-only.
4. Intake review (`/intake`, `/intake/[workflowId]`) plus login and
   onboarding presentation. Remaining inventory stays pending.
