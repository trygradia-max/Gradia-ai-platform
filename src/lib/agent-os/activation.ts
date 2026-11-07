import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

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
  | "agent_not_found"
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
  /** The one tenant-bound agent to enable. The database re-binds it to `shopId`. */
  agentId: string
  existing: ExistingGates
}

const writerResultSchema = z.object({
  outcome: z.enum(["activated", "already_active", "blocked"]),
  code: z.string().nullable().optional(),
})

/**
 * The FINAL authority is `commercial_agent_activate`: one owner-verified database
 * transaction that serializes per shop, counts active agents itself, rechecks the
 * exact reviewed subscription evidence and catalog, and performs the enabling
 * write. This function never supplies a count and never writes `enabled` itself;
 * on a "proceed" the agent has already been activated.
 */
export async function authorizeAgentActivation(
  deps: { sessionClient: SupabaseClient; serviceClient: () => SupabaseClient; runtime: BillingRuntime },
  request: ActivationRequest
): Promise<AgentActivationDecision> {
  // Existing definition/policy/readiness gates run first: not ready means no
  // billing read, no Checkout and no writer call.
  if (!request.existing.ready) {
    return { proceed: false, code: "existing_gate_blocked", billing: null, reasons: request.existing.reasons }
  }

  let service: SupabaseClient
  try {
    service = deps.serviceClient()
  } catch {
    return { proceed: false, code: "billing_state_unavailable", billing: null }
  }

  const { data, error } = await service.rpc("commercial_agent_activate", {
    p_shop: request.shopId,
    p_actor: request.actorId,
    p_agent: request.agentId,
  })
  if (error) {
    // 42501 is "not a live owner of this workspace"; anything else is unknown.
    return {
      proceed: false,
      code: error.code === "42501" ? "owner_required" : "billing_state_unavailable",
      billing: null,
    }
  }
  const parsed = writerResultSchema.safeParse(data)
  if (!parsed.success) return { proceed: false, code: "billing_state_unavailable", billing: null }
  const result = parsed.data

  if (result.outcome === "activated" || result.outcome === "already_active") return { proceed: true }

  switch (result.code) {
    case "agent_not_found":
      return { proceed: false, code: "agent_not_found", billing: null }
    case "active_agent_limit_reached":
      return { proceed: false, code: "active_agent_limit_reached", billing: null }
    case "catalog_mismatch":
      return { proceed: false, code: "catalog_mismatch", billing: null }
    case "billing_not_active":
      break
    default:
      return { proceed: false, code: "billing_state_unavailable", billing: null }
  }

  // Not entitled yet. Read the display state and, if Checkout is the next step,
  // hand back the server-created session. Repeated requests reuse the same open
  // session; they never create another one per click.
  const state = await readCommercialBillingDto(deps.sessionClient, deps.runtime, request.shopId)
  if (state.state === "checkout_required" || state.state === "checkout_pending") {
    const checkout = await requestFounderPilotCheckout(
      { service, runtime: deps.runtime },
      { shopId: request.shopId, actorId: request.actorId, returnTarget: "agents" }
    )
    return { proceed: false, code: checkout.blockingReason ?? "checkout_required", billing: checkout }
  }
  // The database said "not active" even if the display read looks eligible: fail
  // closed rather than trust the weaker read.
  if (state.eligibleToActivate) {
    return { proceed: false, code: "reconciliation_required", billing: { ...state, eligibleToActivate: false } }
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
    case "agent_not_found":
      return "Agent not found."
    case "owner_required":
      return "Only the workspace owner can turn on an agent."
    default:
      return "Billing needs attention before this agent can be turned on."
  }
}
