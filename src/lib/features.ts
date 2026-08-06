/**
 * Feature-flag spine — the single source of truth for what ships in the MVP.
 *
 * Per GRADIA_MVP_PLAN.md §7 / MVP_GATING_PLAN.md: gate, don't delete. Anything
 * set to `false` is intentionally dormant — flip it to `true` to bring the
 * surface back with no other code change.
 *
 * Safety note: `paywall` went live once the full Phase 3 loop landed — Stripe
 * Checkout + webhook lifecycle, the (dashboard) layout gate, metering,
 * fail-closed at credit_limit, and the 'free' default for new signups
 * (20260609 migration). Pre-existing shops are grandfathered plan='active',
 * so enabling it cannot lock out the pilot. Requires STRIPE_SECRET_KEY,
 * STRIPE_PRICE_ID, and STRIPE_WEBHOOK_SECRET in the deploy environment.
 * `freeformPlanner` was enabled in Phase 2 once its executor + guardrails
 * (HITL staging, audience cap, cooldown, opt-out, dry-run preview) landed.
 */
export const FEATURES = {
  agents: {
    voice: true,
    chat: true, // the agentic runtime; catalog entry lights up in Phase 2
    email: true,
    sms: true,
    booking: true,
    memory: true,
    billing: false, // hidden
  },
  integrations: {
    calendar: true,
    crm: true, // Jobber
    email: true,
    sms: true,
    payments: false, // Stripe Connect customer billing — hidden
  },
  whisper: true,
  agenticMode: true, // campaign drafting via the box; the SELF-SERVE scheduled
  // -agent builder surface is gated by workflowBuilder below (FOCUS spec §1)
  freeformPlanner: true, // Phase 2 — executor + guardrails landed
  biChat: true, // Ask Gradia engine — kept; the standalone page is gated below
  workflowBuilder: false, // FOCUS spec §1: hide self-serve scheduled-agent builder for alpha
  askGradiaPage: true, // standalone /chat page re-enabled (engine already shipped)
  slackApprovals: false, // Phase 1 — Slack is now opt-in
  paywall: true, // Phase 3 — subscription gate + metering live
  customerRecovery: true, // import→extract pipeline surfaced as "Import your customers";
  // review queue + acceptance shipped — verify a CSV import end-to-end before prod deploy
  noShowLadder: true, // NEXT-2 — confirm-by-text + backfill nudge around
  // appointments. Sends are HITL-staged like the reminder; flag for easy disable.
  conflictEnforcement: true, // P0-004 — availability checks on every booking/
  // reschedule/block-time path (D-015 hard-block automatic, D-016 documented
  // HITL override). Off = P0-003 service dormant, all paths behave as before.
} as const

export type AgentId = keyof typeof FEATURES.agents
export type IntegrationId = keyof typeof FEATURES.integrations

export const agentEnabled = (id: string): boolean =>
  (FEATURES.agents as Record<string, boolean>)[id] ?? false

export const integrationEnabled = (id: string): boolean =>
  (FEATURES.integrations as Record<string, boolean>)[id] ?? false
