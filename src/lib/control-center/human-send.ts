import { createHash, randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { policyDraftSchema, type PolicyDraft } from "./drafts"
import { evaluatePolicy, modes, type Mode } from "./policy"

const id = z.string().uuid()
const contextSchema = z.object({
  shopId: id,
  actorId: id,
  toPhone: z.string().trim().regex(/^\+\d{8,15}$/),
  body: z.string().trim().min(1).max(1600),
}).strict()
export const HUMAN_SMS_REPLY_DENIED = "Control Center does not allow this SMS reply."

function denied() {
  return { allowed: false as const, reason: HUMAN_SMS_REPLY_DENIED }
}

function strictest(values: readonly (Mode | null | undefined)[]): Mode | null {
  let selected: Mode | null = null
  for (const value of values) {
    if (!value) continue
    if (!selected || modes.indexOf(value) < modes.indexOf(selected)) selected = value
  }
  return selected
}

function payloadHash(parts: { shopId: string; locationId: string; toPhone: string; body: string }) {
  return createHash("sha256").update(JSON.stringify([
    "human-sms-reply",
    parts.shopId,
    parts.locationId,
    parts.toPhone,
    parts.body.normalize("NFC").replace(/\r\n?/g, "\n"),
  ])).digest("hex")
}

/** Pure decision for one owner reply. The operation is fixed here; callers cannot supply a purpose.
 * Consent, quiet hours, STOP and carrier readiness are not this decision. A workspace-wide
 * Autonomous default does not grant the reply — the pure contract requires an explicit action grant.
 */
export function decideHumanSmsReply(input: {
  shopId: string
  actorId: string
  locationId: string
  revision: number
  toPhone: string
  body: string
  draft: PolicyDraft
}) {
  const draft = input.draft
  return evaluatePolicy({
    command: {
      id: randomUUID(),
      shopId: input.shopId,
      locationId: input.locationId,
      operation: "sms.reply",
      connector: "sms",
      intent: "execute",
      source: "human",
      payloadHash: payloadHash(input),
      stagedPolicyVersion: null,
    },
    policy: {
      shopId: input.shopId,
      locationId: input.locationId,
      operation: "sms.reply",
      connector: "sms",
      version: input.revision,
      available: true,
      enabled: draft.enabled,
      workspaceDefault: draft.workspaceDefault,
      workspaceCeiling: draft.workspaceCeiling,
      // An unset connector ceiling inherits. Autonomous is the non-restrictive
      // contract value; it does not grant the action by itself.
      connectorCeiling: draft.connectorCeilings.sms ?? "autonomous",
      actionGrant: draft.actionGrants["sms.reply"] ?? null,
      locationCeiling: draft.locationCeiling,
      roleCeiling: draft.roleCeilings.owner ?? null,
      riskCeiling: strictest(Object.values(draft.riskCeilings)),
      exceptionCeiling: strictest(Object.values(draft.exceptionCeilings)),
    },
    actor: {
      id: input.actorId,
      shopId: input.shopId,
      locationId: input.locationId,
      active: true,
      role: "owner",
      authorizedOperations: ["sms.reply"],
      discountLimit: 0,
    },
    facts: {
      tenantReferencesValid: true,
      safetyPassed: true,
      ready: true,
      setupVerified: false,
      causalActionVerified: false,
      discountAmount: null,
      approval: null,
    },
  })
}

/** Activated policy can refuse an owner reply before any provider call.
 * No active row preserves the existing send. This does not queue a second approval.
 * The caller must already have passed the carrier gate; this function does not send.
 */
export async function authorizeHumanSmsReply(
  db: SupabaseClient,
  context: { shopId: string; actorId: string; toPhone: string; body: string },
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!context || typeof context.shopId !== "string" || context.shopId.length === 0) return denied()
  try {
    const active = await db.from("control_policy_active").select("shop_id,revision").eq("shop_id", context.shopId).maybeSingle()
    if (active.error || active.data === undefined) return denied()
    if (active.data === null) return { allowed: true }
    const parsed = contextSchema.safeParse(context)
    if (!parsed.success || active.data.shop_id !== parsed.data.shopId || !Number.isInteger(active.data.revision) || active.data.revision < 1) return denied()
    const { shopId, actorId, toPhone, body } = parsed.data
    const shop = await db.from("shops").select("id,owner_id").eq("id", shopId).maybeSingle()
    if (shop.error || shop.data?.id !== shopId || shop.data.owner_id !== actorId) return denied()
    const member = await db.from("shop_memberships").select("user_id,shop_id,role,active").eq("shop_id", shopId).eq("user_id", actorId).maybeSingle()
    if (member.error || member.data?.user_id !== actorId || member.data.shop_id !== shopId || member.data.role !== "owner" || member.data.active !== true) return denied()
    const location = await db.from("shop_locations").select("id,shop_id").eq("shop_id", shopId).maybeSingle()
    if (location.error || location.data?.shop_id !== shopId || !id.safeParse(location.data?.id).success) return denied()
    const history = await db.from("control_policy_history").select("shop_id,location_id,revision,definition").eq("shop_id", shopId).eq("revision", active.data.revision).maybeSingle()
    if (history.error || history.data?.shop_id !== shopId || history.data.revision !== active.data.revision || history.data.location_id !== location.data.id) return denied()
    const policy = policyDraftSchema.safeParse(history.data.definition)
    if (!policy.success) return denied()
    const decision = decideHumanSmsReply({
      shopId, actorId, locationId: location.data.id, revision: active.data.revision, toPhone, body, draft: policy.data,
    })
    return decision.allowed ? { allowed: true } : denied()
  } catch {
    return denied()
  }
}
