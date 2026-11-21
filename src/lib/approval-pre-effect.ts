import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Pre-effect recheck for effects that run AFTER the approval claim has committed.
 *
 * `claim_control_action` atomically authorizes an approval, and for record commands (customer, vehicle, note) it applies
 * the effect inside that same transaction. A booking, a draft quote and a text cannot: they run afterwards, in
 * application code and (for a text) at a provider. Between the claim and the effect a call's consent can be declined, the
 * evidence can change, the requester can be revoked, the agent definition can be retired or the customer's identity can
 * change. So the executor asks the database once more IMMEDIATELY before each such effect and does nothing unless the
 * answer is an explicit yes.
 *
 * The database answers `{ ok: true }` for every action that is not a Call Copilot proposal (the unchanged path) and
 * re-verifies, for a Call Copilot proposal, exactly what the claim verified: the action was claimed by a person, the
 * payload is unedited, the requester is still authorized, consent still permits CRM mutation, the sealed evidence
 * revision is current, the bound agent definition is still active, and the customer identity is unchanged.
 *
 * Fail closed: an error, a malformed answer or anything but an explicit `ok: true` is a denial. Nothing is inferred.
 *
 * Honest limit: this narrows the window between authorization and effect to the few statements between the check and the
 * effect; it cannot make an external provider call atomic with a database read. A decline recorded after the check but
 * before the provider accepts the request is not caught by this check.
 */

export type PreEffectCheck = { allowed: true } | { allowed: false; reason: string; message: string }

const MESSAGES: Record<string, string> = {
  call_action_not_claimed: "This call proposal was not approved by a person. Nothing was changed.",
  call_proposal_unknown: "This call proposal could not be found. Nothing was changed.",
  call_proposal_edited: "This call proposal was edited after it was created. Nothing was changed.",
  call_consent_unavailable: "Consent for this call no longer permits using it. Nothing was changed.",
  call_evidence_changed: "The call evidence changed since this proposal was made. Nothing was changed.",
  call_requester_revoked: "The person who requested this proposal no longer has access. Nothing was changed.",
  call_definition_inactive: "The agent revision behind this proposal is no longer active. Nothing was changed.",
  call_crm_state_changed: "The customer record changed since this proposal was made. Nothing was changed.",
  call_proposal_expired: "The proposed appointment time has passed. Nothing was changed.",
}
const UNVERIFIED = "The call evidence could not be verified just before this ran. Nothing was changed."

export async function recheckBeforeEffect(
  supabase: SupabaseClient,
  action: { id: string; shop_id: string },
): Promise<PreEffectCheck> {
  let data: unknown
  try {
    const res = await supabase.rpc("call_copilot_pre_effect_recheck", { p_shop: action.shop_id, p_action: action.id })
    if (res.error) return { allowed: false, reason: "call_recheck_unavailable", message: UNVERIFIED }
    data = res.data
  } catch {
    return { allowed: false, reason: "call_recheck_unavailable", message: UNVERIFIED }
  }
  const answer = typeof data === "string" ? safeParse(data) : data
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const a = answer as { ok?: unknown; denied?: unknown }
    if (a.ok === true) return { allowed: true }
    if (a.ok === false && typeof a.denied === "string") {
      return { allowed: false, reason: a.denied, message: MESSAGES[a.denied] ?? UNVERIFIED }
    }
  }
  return { allowed: false, reason: "call_recheck_unavailable", message: UNVERIFIED }
}

function safeParse(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}
