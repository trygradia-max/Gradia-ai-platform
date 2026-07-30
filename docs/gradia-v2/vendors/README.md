# Vendors — Provider Registry & Rules

_Created 2026-07-27 by the Organizer (vendor-architecture amendment). Governs provider classification, dependency rules, and adoption. The per-provider facts live in the classified docs below and the consolidated `registry.md`; the boundary rule is decision **D-029** / `../adr/ADR-002-provider-boundaries.md`._

## Structure

| Path | Classification | Providers |
|---|---|---|
| `core/` | **Core platform infrastructure** — supports foundational Gradia operations | Supabase · Vercel · Stripe · Twilio · Sentry |
| `ai/` | **AI and voice providers** — strategic but replaceable behind Gradia-owned abstractions | Anthropic · OpenAI · Vapi |
| `transitional/` | **Transitional connectivity infrastructure** — kept through stabilization, must remain replaceable | Aurinko |
| `customer-integrations/` | **Optional customer integrations** — never foundational; Gradia fully operational without them | Jobber (optional) · Housecall Pro (quarantined) |
| `planned-evaluations/` | **Planning-only evaluations** — no vendor selected or installed | Google Calendar/Gmail · Microsoft Graph/Outlook · product analytics · transactional email · accounting · payment/POS |
| `registry.md` | One consolidated table, every provider, all fields | — |

## Controlled statuses

`core` · `strategic` · `transitional` · `optional` · `planned` · `quarantined` · `deprecated` · `removed`. Every provider doc and every registry row carries exactly one. Unknown facts are labeled **requires verification** — never invented.

## The provider-boundary rule (D-029, ADR-002 — locked)

**Gradia domains depend on Gradia-owned interfaces, not vendor-specific behavior.**

| Domain | Gradia-owned interface | Providers behind it |
|---|---|---|
| Calendar | `CalendarProvider` | Aurinko / Google Calendar / Microsoft Graph |
| AI gateway | `ModelProvider` | Anthropic / OpenAI |
| Voice | `VoiceProvider` | Vapi / future provider |
| Telephony | `TelephonyProvider` | Twilio / future provider |
| Payments | `PaymentsProvider` | Stripe / future provider |
| Customer integration | `CRMConnector` | Jobber / Housecall Pro / future provider |

Provider-specific IDs, cursors, payloads and synchronization state stay inside integration records and provider adapters wherever practical. **Core business entities use Gradia-owned identifiers.** For the AI classification specifically: AI domains use the centralized AI gateway; application modules must not hardcode model IDs; retries, timeouts, costs, latency and failures are recorded at the gateway; no core business logic depends on one model provider. (Current reality: the LLM seam does not exist yet — audit doc 07/09; it lands in E01/P1. Voice/telephony/CRM seams already exist and are disciplined.)

## New provider adoption requirements (binding)

Before Gradia adopts ANY new provider, all of the following are required:

1. Specific customer or product need
2. Build-versus-buy analysis
3. Cost and gross-margin analysis (against `../15-cost-and-margin-model.md` floors)
4. Data and privacy analysis
5. Security review
6. Reliability evaluation
7. Test environment
8. Webhook behavior
9. Idempotency support (provider event identifiers — D-023)
10. Rate-limit behavior
11. Tenant-isolation analysis
12. Monitoring plan
13. Outage fallback
14. Exit strategy
15. Gradia-owned abstraction boundary (D-029)
16. **Founder approval**
17. ADR when architecture is materially affected

A `planned-evaluations/` doc holding these answers is the entry ticket; the founder decision goes through `../program/decision-queue.md`.

## Standing directions (approved 2026-07-27)

- **Aurinko** stays through stabilization; Gradia's database remains the appointment source of truth (D-013); core calendar records must not depend on Aurinko-specific identifiers; Google Calendar and Microsoft Graph capabilities are specified independently (`planned-evaluations/`); direct provider integrations may be evaluated later (Q-21).
- **Jobber** — optional, customer-demand driven, feature-flagged, useful for migration/temporary sync/one-way export; core workflows never depend on it; re-evaluate ongoing sync after operational parity (Q-20).
- **Housecall Pro** — quarantined: not publicly marketed, flag stays disabled, no new product investment, API shapes require live verification; evaluate import-only vs removal (Q-19, review ticket `../tickets/P3-001-housecallpro-dependency-review.md`). Organizer recommendation: *use Housecall Pro as an import source or remove it after dependency review; do not maintain it as a core bidirectional integration without customer demand.*
- **Stripe Connect remains the first customer-payment architecture (D-019).** Square is a later evaluation (import/POS sync), never a Connect replacement in this amendment.
