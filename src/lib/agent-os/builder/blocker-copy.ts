import { ACTIVATION_BLOCKERS, isActivationBlocker, type ActivationBlocker, type BuilderStepKey } from "@/lib/agent-os/definition-dto"

/**
 * Reviewed, plain-language copy for EVERY activation blocker the backend can return.
 * The record is keyed by the full vocabulary, so a new backend code is a compile error
 * here and a failing source-lock test, never a blank or a success state. Anything that
 * is not a known code renders as `evidence_unavailable` (fail closed).
 */
export type BlockerCopy = {
  title: string
  detail: string
  /** A safe next step: an in-app path, a builder step, or a reload. Never a provider or checkout URL. */
  action?: { label: string; href?: string; step?: BuilderStepKey }
}

export const BLOCKER_COPY: Record<ActivationBlocker, BlockerCopy> = {
  owner_activation_required: { title: "Only the owner can activate", detail: "Managers and staff can review this agent, but only the workspace owner can activate it." },
  agent_not_found: { title: "Agent not found", detail: "This agent no longer exists in your workspace.", action: { label: "Back to agents", href: "/agents" } },
  definition_not_found: { title: "No saved definition yet", detail: "Save the first revision of this agent before it can be activated.", action: { label: "Go to Job", step: "job" } },
  revision_not_found: { title: "Revision not found", detail: "That revision does not exist. Reload to see the latest saved revision." },
  invalid_definition: { title: "The saved definition is not valid", detail: "Fix the highlighted fields and save a new revision.", action: { label: "Go to Job", step: "job" } },
  invalid_scope: { title: "Workspace check failed", detail: "Gradia could not confirm which workspace this belongs to. Reload and try again." },
  unsupported_schema: { title: "Unsupported definition version", detail: "This revision uses a format this version of Gradia cannot activate. Save a new revision in the builder.", action: { label: "Go to Job", step: "job" } },
  definition_hash_mismatch: { title: "This revision changed", detail: "The revision you reviewed is no longer the one on file. Reload the latest and review it again." },
  pointer_changed: { title: "Another change landed first", detail: "This agent's active revision changed after you opened it, possibly in another tab. Reload to review the current state." },
  policy_unavailable: { title: "No active Control Center policy", detail: "Publish a Control Center policy so Gradia knows what this agent may do.", action: { label: "Open Control Center", href: "/control-center" } },
  policy_stale: { title: "Control Center policy changed", detail: "The policy changed after readiness was checked. Reload and review again." },
  connector_stale: { title: "A connection changed", detail: "A phone, text, email or calendar connection changed while readiness was being checked. Reload and review again." },
  knowledge_unavailable: { title: "Knowledge could not be checked", detail: "Gradia could not read your reviewed knowledge. Try again in a moment." },
  knowledge_stale: { title: "Reviewed knowledge changed", detail: "Your reviewed knowledge was updated after readiness was checked. Reload and review again." },
  knowledge_review_required: { title: "Knowledge needs a saved review", detail: "A selected knowledge source is not pinned to a reviewed, published revision. Select it again and save.", action: { label: "Go to Knowledge", step: "knowledge" } },
  memory_revoked: { title: "A knowledge source was revoked", detail: "A pinned knowledge source was revoked. Remove it or pick a current one, then save a new revision.", action: { label: "Go to Knowledge", step: "knowledge" } },
  memory_changed: { title: "A knowledge source changed", detail: "A pinned source is no longer the reviewed text it was saved with. Re-select it and save.", action: { label: "Go to Knowledge", step: "knowledge" } },
  memory_stale: { title: "A newer knowledge version exists", detail: "A pinned source has a newer published version. Re-select it and save a new revision.", action: { label: "Go to Knowledge", step: "knowledge" } },
  memory_expired: { title: "A knowledge source expired", detail: "A pinned source is past its review window. Review and publish it again, then re-select it.", action: { label: "Open knowledge", href: "/settings" } },
  tool_not_ready: { title: "A selected tool is not ready", detail: "A tool needs a connection that is not set up yet. Connect it or remove the tool.", action: { label: "Review tools", step: "tools" } },
  tool_policy_blocked: { title: "Control Center blocks a tool", detail: "Your Control Center policy turns off a selected tool. Change the policy or remove the tool.", action: { label: "Open Control Center", href: "/control-center" } },
  post_mvp_tool_disabled: { title: "A tool is not available yet", detail: "Outbound calling and campaign sending are not available. Remove them to continue.", action: { label: "Review tools", step: "tools" } },
  limits_invalid: { title: "Limits are outside the allowed range", detail: "One or more limits are outside what Gradia allows. Adjust them and save.", action: { label: "Go to Limits", step: "limits" } },
  evaluation_required: { title: "Testing is not available yet", detail: "Activation needs a passing test of this exact revision. The test runner is not available yet, so this agent cannot be activated.", action: { label: "See Test", step: "test" } },
  safety_evaluation_failed: { title: "The safety test did not pass", detail: "The latest test of this revision found a safety problem. Change the definition and save a new revision.", action: { label: "Go to Job", step: "job" } },
  quality_evaluation_failed: { title: "The quality test did not pass", detail: "The latest test of this revision scored below the 95% bar. Change the definition and save a new revision.", action: { label: "Go to Job", step: "job" } },
  invalid_evaluation_time: { title: "Test evidence is not usable", detail: "The latest test result has an invalid time and cannot count. Run the test again once it is available.", action: { label: "See Test", step: "test" } },
  active_agent_limit_reached: { title: "Two agents are already active", detail: "Your workspace can run two active agents. Pause one before activating another.", action: { label: "Open agents", href: "/agents" } },
  catalog_mismatch: { title: "Plan details changed", detail: "The Founder Pilot terms changed after you started. Reload and review them again." },
  billing_not_active: { title: "Founder Pilot checkout is needed", detail: "Activation starts the Founder Pilot subscription. A card is required to activate, not to build or test." },
  billing_state_unavailable: { title: "Billing could not be checked", detail: "Gradia could not confirm your subscription. Nothing was activated. Try again in a moment." },
  checkout_required: { title: "Checkout is required", detail: "Start secure Founder Pilot checkout to activate. Nothing is charged until you finish it." },
  checkout_in_progress: { title: "Checkout is in progress", detail: "A checkout session is already open. Finish it, or wait for it to expire, then try again." },
  checkout_completed_awaiting_evidence: { title: "Waiting for payment confirmation", detail: "Checkout finished, but the payment is not confirmed yet. Activation unlocks when it is. Nothing is active." },
  subscription_past_due: { title: "Subscription payment is past due", detail: "Update the payment method to continue. Nothing was activated." },
  subscription_canceled: { title: "Subscription is canceled", detail: "The Founder Pilot subscription is canceled. Start a new checkout to activate." },
  subscription_incomplete: { title: "Subscription is incomplete", detail: "The first payment did not complete. Finish checkout to activate." },
  subscription_unknown: { title: "Subscription state is unclear", detail: "Gradia cannot confirm the subscription status, so activation is held. Nothing was activated." },
  reconciliation_required: { title: "Billing needs review", detail: "Gradia found conflicting billing records and is holding activation until they are reconciled. Nothing was activated." },
  billing_unconfigured: { title: "Billing is not set up", detail: "Founder Pilot billing is not configured for this environment, so activation is unavailable." },
  billing_misconfigured: { title: "Billing is misconfigured", detail: "Founder Pilot billing is not configured correctly, so activation is unavailable." },
  owner_required: { title: "Only the owner can start billing", detail: "Ask the workspace owner to activate this agent." },
  evidence_unavailable: { title: "Readiness could not be confirmed", detail: "Gradia could not verify the evidence needed to activate. Nothing was activated. Try again in a moment." },
  evidence_blocked: { title: "Activation is blocked", detail: "One or more checks failed. Fix the items above and try again." },
}

const FALLBACK: ActivationBlocker = "evidence_unavailable"

/** Total over unknown input: an unrecognized code renders as "could not be confirmed", never as success or nothing. */
export function describeBlocker(code: unknown): { code: ActivationBlocker; copy: BlockerCopy } {
  const known = isActivationBlocker(code) ? code : FALLBACK
  return { code: known, copy: BLOCKER_COPY[known] }
}

export function describeBlockers(codes: readonly unknown[]): { code: ActivationBlocker; copy: BlockerCopy }[] {
  const seen = new Set<ActivationBlocker>()
  const out: { code: ActivationBlocker; copy: BlockerCopy }[] = []
  for (const raw of codes) {
    const entry = describeBlocker(raw)
    if (seen.has(entry.code)) continue
    seen.add(entry.code)
    out.push(entry)
  }
  return out
}

export const ALL_BLOCKER_CODES: readonly ActivationBlocker[] = ACTIVATION_BLOCKERS
