/**
 * Feature-flag spine — the single source of truth for what ships in the MVP.
 *
 * Per GRADIA_MVP_PLAN.md §7 / MVP_GATING_PLAN.md: gate, don't delete. Anything
 * set to `false` is intentionally dormant — flip it to `true` to bring the
 * surface back with no other code change.
 *
 * Safety note: `paywall` stays `false` until the Phase 3 subscription gate is
 * built and verified — enabling a half-built gate would lock everyone out.
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
    instagram: false, // hidden
    billing: false, // hidden
  },
  integrations: {
    calendar: true,
    crm: true, // Jobber
    email: true,
    sms: true,
    instagram: false, // hidden
    facebook: false, // hidden
    payments: false, // Stripe Connect customer billing — hidden
  },
  whisper: true,
  agenticMode: true,
  freeformPlanner: true, // Phase 2 — executor + guardrails landed
  biChat: true, // Ask Gradia
  slackApprovals: false, // Phase 1 — Slack is now opt-in
  paywall: false, // Phase 3 — flip on when the subscription gate is built
} as const

export type AgentId = keyof typeof FEATURES.agents
export type IntegrationId = keyof typeof FEATURES.integrations

export const agentEnabled = (id: string): boolean =>
  (FEATURES.agents as Record<string, boolean>)[id] ?? false

export const integrationEnabled = (id: string): boolean =>
  (FEATURES.integrations as Record<string, boolean>)[id] ?? false
