import type { SupabaseClient } from "@supabase/supabase-js"

import { FOUNDER_PILOT_POLICY } from "@/lib/approved-commercial-catalog"
import type { CommercialBillingDto, CommercialBlockingReason } from "@/lib/commercial-billing"
import {
  readCommercialBillingDto,
  requestFounderPilotCheckout,
  type BillingRuntime,
} from "@/lib/commercial-billing-service"

/**
 * The single seam every agent ACTIVATION path calls before it activates anything.
 *
 * Audit (2026-11-06): there is no persisted Agent OS definition store yet
 * (`compileAgentDefinition` is a pure compiler). The one persisted per-agent
 * activation today is `setCustomAgentEnabled(enabled: true)`, which now calls this
 * seam. Draft creation (`saveCustomAgent`, always `enabled: false`) never does, so
 * configuring and testing never requests billing.
 *
 * Order is deliberate and every gate is an AND, never a substitute:
 *   1. existing gates (definition/policy/review/connector/memory/approval) — if
 *      they are not ready, nothing else runs and no Checkout is created;
 *   2. the two-active-agent entitlement;
 *   3. reviewed, persisted Founder Pilot subscription evidence.
 * A billing "yes" only lets the existing activation command proceed; it grants no
 * tool, mode, connector or approval authority.
 */

export type ExistingGates = { ready: true } | { ready: false; reasons: string[] }

export type ActivationBlockCode =
  | "existing_gate_blocked"
  | "active_agent_limit_reached"
  | CommercialBlockingReason

export type AgentActivationDecision =
  | { proceed: true }
  | {
      proceed: false
      code: ActivationBlockCode
      /** Present for every billing outcome; the Checkout URL only while one is open. */
      billing: CommercialBillingDto | null
      /** Exact existing-gate reasons when `code` is `existing_gate_blocked`. */
      reasons?: string[]
    }

export type ActivationRequest = {
  shopId: string
  /** The authenticated user; the database re-verifies they are a live owner. */
  actorId: string
  /** Whether the agent being activated is already active (an idempotent no-op). */
  alreadyActive: boolean
  /** Currently active agents in this workspace, or null if it could not be read. */
  activeAgentCount: number | null
  existing: ExistingGates
}

export async function authorizeAgentActivation(
  deps: { sessionClient: SupabaseClient; serviceClient: () => SupabaseClient; runtime: BillingRuntime },
  request: ActivationRequest
): Promise<AgentActivationDecision> {
  if (request.alreadyActive) return { proceed: true }

  if (!request.existing.ready) {
    return { proceed: false, code: "existing_gate_blocked", billing: null, reasons: request.existing.reasons }
  }

  // Unknown count fails closed: the limit cannot be shown to hold.
  if (
    request.activeAgentCount === null ||
    request.activeAgentCount >= FOUNDER_PILOT_POLICY.includedActiveAgents
  ) {
    return { proceed: false, code: "active_agent_limit_reached", billing: null }
  }

  const state = await readCommercialBillingDto(deps.sessionClient, deps.runtime, request.shopId)
  if (state.eligibleToActivate) return { proceed: true }

  // Billing is required but absent (or its Checkout is open): hand back the
  // server-created Checkout. Repeated requests reuse the same open session; they
  // never create another one per click.
  if (state.state === "checkout_required" || state.state === "checkout_pending") {
    let service: SupabaseClient
    try {
      service = deps.serviceClient()
    } catch {
      return { proceed: false, code: "billing_state_unavailable", billing: state }
    }
    const checkout = await requestFounderPilotCheckout(
      { service, runtime: deps.runtime },
      { shopId: request.shopId, actorId: request.actorId, returnTarget: "agents" }
    )
    return {
      proceed: false,
      code: checkout.blockingReason ?? "checkout_required",
      billing: checkout,
    }
  }

  return { proceed: false, code: state.blockingReason ?? "subscription_unknown", billing: state }
}

/**
 * Plain, non-secret fallback sentence for a refused activation. The owner UI owns
 * final copy and should key off `code`; this only keeps callers that show `error`
 * honest. It never contains a URL, key or provider text.
 */
export function activationBlockedMessage(code: ActivationBlockCode): string {
  switch (code) {
    case "existing_gate_blocked":
      return "This agent isn't ready to turn on yet."
    case "active_agent_limit_reached":
      return `Founder Pilot includes up to ${FOUNDER_PILOT_POLICY.includedActiveAgents} active agents. Turn one off first.`
    case "checkout_required":
      return "Add a card to turn on your first agent."
    case "checkout_in_progress":
    case "checkout_completed_awaiting_evidence":
      return "Your payment is still being confirmed. Try again shortly."
    case "subscription_past_due":
      return "Your last payment didn't go through, so new agents can't be turned on."
    case "subscription_canceled":
      return "Your subscription has ended, so new agents can't be turned on."
    case "owner_required":
      return "Only the workspace owner can turn on an agent."
    default:
      return "Billing needs attention before this agent can be turned on."
  }
}
