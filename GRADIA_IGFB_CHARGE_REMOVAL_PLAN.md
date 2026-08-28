> **⚠️ SUPERSEDED (banner added 2026-08-28).** This plan has been replaced. Do NOT work from it. Successor: `platform/docs/gradia-v2/` — roadmap `10-roadmap.md`, decisions `11-decision-log.md`, precedence `16-document-source-map.md`.

# Removal Plan — Instagram, Facebook (+ Meta), and `charge_customer`

> Hard delete on branch `mvp/phase-0-subtraction`. **Preserve all platform billing.**
> DB rule: do NOT drop columns or Postgres enum values — leave them dormant. Remove only from TypeScript types + code.
> Apply in ONE pass; finish with `npx tsc --noEmit` + `npm run test` until green. (No `typecheck` script exists.)

## A. Delete outright
**Instagram:** `src/app/actions/outbound-instagram.ts`, `src/lib/instagram-drafter.ts`, `src/lib/instagram-classifier.ts`, `src/components/gradia/instagram-settings-card.tsx`
**Facebook:** `src/app/actions/outbound-facebook.ts`, `src/lib/facebook-drafter.ts`, `src/components/gradia/facebook-settings-card.tsx`
**Meta (orphaned once both channels gone):** `src/app/api/meta/webhook/route.ts`, `src/app/api/meta/auth/start/route.ts`, `src/app/api/meta/auth/callback/route.ts`, `src/lib/meta.ts`, `src/lib/meta-oauth.ts`, `src/app/actions/meta-oauth.ts`, `src/components/gradia/meta-page-picker.tsx`, `src/components/gradia/meta-callback-toast.tsx` (+ empty `src/app/api/meta/*` dirs)

## B. Shared files to edit (from original spec)
`src/lib/types/database.ts`, `src/lib/approvals.ts`, `src/app/actions/approvals.ts`, `src/app/api/slack/interactivity/route.ts`, `src/lib/slack.ts`, `src/app/(dashboard)/approvals/[id]/page.tsx`, `src/components/gradia/pending-proposal-editor.tsx`, `src/components/gradia/interaction-timeline.tsx`, `src/components/gradia/customers-table.tsx`, `src/lib/autonomy.ts`, `src/lib/stripe.ts`, `src/lib/vapi-tools.ts`, `src/lib/features.ts`, `src/app/(dashboard)/settings/page.tsx`, `src/app/actions/shop.ts`

## C. Additional consumers the first map MISSED (build-breaking — must edit)
**charge_customer:** `src/components/gradia/activity-event.tsx`, `src/components/gradia/approvals-list.tsx`, `src/components/gradia/whisper-button.tsx`, `src/lib/data/pending-actions.ts`, `src/lib/mcp/server.ts` (tools `propose_charge`/`propose_ig_dm`/`propose_fb_dm` + channel enums + recent-customers SELECT)
**IG/FB:** `src/lib/data/agents.ts`, `src/components/gradia/agent-card.tsx`, `src/lib/data/channels.ts`, `src/components/gradia/channel-connection-card.tsx`, `src/lib/customer-context.ts`, `src/lib/bi-tools.ts`, `src/app/actions/customers.ts`, `src/lib/data/customers.ts`, `src/components/gradia/customer-merge-dialog.tsx`, `src/app/(dashboard)/customers/[id]/page.tsx`, `src/proxy.ts` (real middleware — `/api/meta` route + flag gates), `src/app/(dashboard)/agents/page.tsx`, `src/app/how-it-works/page.tsx` (marketing copy), `src/components/gradia/welcome-modal.tsx`

## D. Tests
- `eval/guardrails.test.ts` — drop the 3 `charge_customer` assertions (and any IG/FB).
- `eval/integration/approvals.int.test.ts` — the rollback test uses `charge_customer` as a post-claim failure; **repoint it to `book_appointment`** (fails after claim with no Aurinko token, still rolls back — preserves test intent).

## E. Resolved judgment calls (verified against code)
- **`PaymentRow` → KEEP** — used by preserved Stripe webhook `handleChargeRefunded` + `payments.ts` backfill (Connect invoice mirror, not the charge action).
- **`payments.ts` / `iteratePaidInvoices` → KEEP** — serve the Connect invoice mirror/backfill.
- **`stripe.ts`** — delete ONLY `findOrCreateStripeCustomer`, `chargeCustomerViaInvoice`, `StripeInvoice`, `StripeCustomer`; KEEP `iteratePaidInvoices`/`StripePaidInvoice` + all account/onboarding/subscription/webhook fns.
- **`slack.ts`** — KEEP `sendPaymentReceivedNotice`/`Failed`/`Refunded` + `formatMoney` (serve preserved Connect webhook); delete only the charge-approval + IG/FB-DM card helpers.
- **`ShopRow` IG/FB columns** — remove from TS type (only consumers are deleted files); leave dormant in DB.
- **`payments`/`billing`/`instagram`/`facebook` flags** — none gate platform billing or the paywall (`FEATURES.paywall` is separate); safe to remove, but update reads in `proxy.ts`, `data/agents.ts`, `bi-tools.ts`, `settings/page.tsx` in the same pass.
- **DB** — `instagram_handle`, `facebook_id`, and enum values `send_instagram_dm`/`send_facebook_dm`/`charge_customer` stay dormant (no migration).
