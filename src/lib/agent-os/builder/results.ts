import type { ActivateDefinitionResult, CreateRevisionResult, LifecycleChangeResult } from "@/lib/agent-os/definition-store"
import type { CommercialBillingDto } from "@/lib/commercial-billing"

/** UI-facing interpretation of the Build 1 command results. Nothing here ever turns a failure into success. */

export type SaveOutcome =
  | { kind: "saved"; outcome: "created" | "replayed"; revision: number; definitionHash: string }
  | { kind: "conflict" }
  | { kind: "error"; message: string; retryable: boolean }

export function interpretSave(result: CreateRevisionResult): SaveOutcome {
  if (result.ok) return { kind: "saved", outcome: result.outcome, revision: result.revision, definitionHash: result.definitionHash }
  switch (result.code) {
    case "conflict":
    case "parent_not_found":
      return { kind: "conflict" }
    case "forbidden":
      return { kind: "error", message: "Only the workspace owner can save changes to an agent.", retryable: false }
    case "agent_not_found":
      return { kind: "error", message: "This agent no longer exists.", retryable: false }
    case "legacy_agent_enabled":
      return { kind: "error", message: "This agent is a legacy agent and is currently turned on. Turn it off first, then save its first revision.", retryable: false }
    case "memory_not_selectable":
      return { kind: "error", message: "A selected knowledge source is not a current, published source. Pick a current one and save again.", retryable: false }
    case "invalid_definition":
      return { kind: "error", message: "Gradia could not accept these values. Check each step for errors and try again.", retryable: false }
    default:
      return { kind: "error", message: "Gradia could not save right now. Nothing was changed. Try again.", retryable: true }
  }
}

export type ActivateOutcome =
  | { kind: "activated"; revision: number; alreadyActive: boolean }
  | { kind: "blocked"; reasons: string[]; billing: CommercialBillingDto | null; checkoutUrl: string | null }
  | { kind: "forbidden" }

/**
 * Only the server-created Founder Pilot checkout URL is ever surfaced, and only when the
 * server says Checkout is the required next step. Success requires `ok: true` from the server.
 */
export function interpretActivation(result: ActivateDefinitionResult): ActivateOutcome {
  if (result.ok) return { kind: "activated", revision: result.revision, alreadyActive: result.outcome === "already_active" }
  if (result.code === "forbidden") return { kind: "forbidden" }
  const url = result.billing?.checkoutUrl
  const checkoutUrl = typeof url === "string" && /^https:\/\/checkout\.stripe\.com\//.test(url) ? url : null
  return { kind: "blocked", reasons: result.reasons.length ? result.reasons : [result.code], billing: result.billing, checkoutUrl }
}

export type LifecycleOutcome = { kind: "changed" } | { kind: "unchanged" } | { kind: "stale" } | { kind: "error"; message: string }

export function interpretLifecycle(result: LifecycleChangeResult): LifecycleOutcome {
  if (result.ok) return result.outcome === "changed" ? { kind: "changed" } : { kind: "unchanged" }
  switch (result.code) {
    case "pointer_changed":
      return { kind: "stale" }
    case "forbidden":
      return { kind: "error", message: "Only the workspace owner can pause or block an agent." }
    case "no_active_definition":
      return { kind: "error", message: "This agent has no active definition to pause or block." }
    case "invalid_transition":
      return { kind: "error", message: "That change is not allowed from the agent's current state." }
    case "invalid":
      return { kind: "error", message: "Enter a reason of 1–200 characters." }
    case "agent_not_found":
      return { kind: "error", message: "This agent no longer exists." }
    default:
      return { kind: "error", message: "Gradia could not change this agent right now. Nothing was changed. Try again." }
  }
}
