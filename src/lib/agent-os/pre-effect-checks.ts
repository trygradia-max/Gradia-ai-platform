import type { SupabaseClient } from "@supabase/supabase-js"

import { loadChannelReadiness } from "@/lib/data/channel-readiness"
import { assessCommercialExecution } from "@/lib/commercial-execution-gate"
import { ACTIONS, evaluatePolicy, modes, type Mode, type Operation } from "@/lib/control-center/policy"
import { policyDraftSchema, type PolicyDraft } from "@/lib/control-center/drafts"
import { evaluateCustomerSendPolicy, type SendCategory } from "@/lib/send-policy"
import type { PreEffectCheck } from "@/lib/agent-os/run-lifecycle"
import type { ShopRow } from "@/lib/types/database"

/**
 * Re-evaluation of every authority an effect depends on, IMMEDIATELY before its attempt is admitted.
 *
 * The six required checks are fixed and finite: policy, consent, readiness, approval, budget, grants.
 * Each resolver is fail-closed: a throw, a failed read or an unexpected value is `unknown`, which the
 * database treats exactly like `fail` (the attempt is refused and the evidence is recorded). The database
 * independently re-verifies what it can (binding, immutable grant, credit budget, the approval's current
 * status and payload hash) in the same transaction that starts the attempt, so these checks are
 * defense in depth, not the only line.
 */

export const REQUIRED_CHECKS = ["policy", "consent", "readiness", "approval", "budget", "grants"] as const
export type CheckName = (typeof REQUIRED_CHECKS)[number]

/** Recipient facts for a customer-contacting execute command. Never model-supplied. */
export type ConsentSubject = {
  channel: "sms" | "email"
  destination: string
  customerId: string | null
  category: SendCategory
  /** Message body/subject, so a transactional service proof is bound to the exact content. */
  body?: string
  subject?: string
  serviceProof?: string | null
}

export type EffectCheckInput = {
  shopId: string
  agentId: string
  commandId: string
  operation: Operation
  intent: "stage" | "execute"
  payloadHash: string
  approvalRequired: boolean
  pendingActionId?: string
  /** From the run's immutable bound snapshot. */
  tools: { operation: string; maximumMode: Mode }[]
  boundPolicyRevision: number | null
  subject?: ConsentSubject
  /** Content safety verdict from the trusted classifier. Missing means NOT verified. */
  safetyVerified?: boolean
  causalActionVerified?: boolean
  now?: () => number
}

type Resolver = (input: EffectCheckInput, prior: Partial<Record<CheckName, PreEffectCheck>>) => Promise<PreEffectCheck>
export type EffectCheckResolvers = Record<CheckName, Resolver>

const pass = (name: CheckName, extra: Partial<PreEffectCheck> = {}): PreEffectCheck => ({ name, status: "pass", ...extra })
const fail = (name: CheckName, code: string, status: "fail" | "unknown" = "fail"): PreEffectCheck => ({ name, status, code })

/** Runs all six resolvers in dependency order. Always returns exactly the six names, one each. */
export async function recheckBeforeEffect(resolvers: EffectCheckResolvers, input: EffectCheckInput): Promise<PreEffectCheck[]> {
  const prior: Partial<Record<CheckName, PreEffectCheck>> = {}
  // policy depends on readiness and approval, so it runs last.
  for (const name of ["grants", "approval", "readiness", "consent", "budget", "policy"] as const) {
    let result: PreEffectCheck
    try {
      result = await resolvers[name](input, prior)
      if (!result || result.name !== name || !["pass", "fail", "unknown", "not_applicable"].includes(result.status)) result = fail(name, "invalid_result", "unknown")
    } catch {
      result = fail(name, "check_unavailable", "unknown")
    }
    prior[name] = result
  }
  return REQUIRED_CHECKS.map((n) => prior[n]!)
}

const rank = (m: Mode) => modes.indexOf(m)

// ------------------------------------------------------------ default resolvers

type PolicyContext = { revision: number; draft: PolicyDraft; locationId: string; ownerId: string }

async function loadPolicyContext(db: SupabaseClient, shopId: string): Promise<PolicyContext | null> {
  const active = await db.from("control_policy_active").select("revision").eq("shop_id", shopId).maybeSingle()
  if (active.error || !active.data) return null
  const [history, location, shop] = await Promise.all([
    db.from("control_policy_history").select("definition,location_id").eq("shop_id", shopId).eq("revision", active.data.revision).maybeSingle(),
    db.from("shop_locations").select("id").eq("shop_id", shopId).maybeSingle(),
    db.from("shops").select("owner_id").eq("id", shopId).maybeSingle(),
  ])
  if (history.error || location.error || shop.error || !location.data || !shop.data) return null
  const parsed = policyDraftSchema.safeParse(history.data?.definition)
  if (!parsed.success || history.data?.location_id !== location.data.id) return null
  return { revision: active.data.revision as number, draft: parsed.data, locationId: location.data.id as string, ownerId: shop.data.owner_id as string }
}

function strictest(values: readonly (Mode | null | undefined)[]): Mode | null {
  let selected: Mode | null = null
  for (const value of values) if (value && (!selected || rank(value) < rank(selected))) selected = value
  return selected
}

const CONNECTOR_CHANNEL = { sms: "texting", email: "email", voice: "calls", meta: "meta" } as const

/** Production resolvers over a service-role client. Reads only; nothing here sends or writes. */
export function serviceEffectChecks(service: SupabaseClient, env: Record<string, string | undefined> = process.env): EffectCheckResolvers {
  const readinessOf = async (shopId: string, connector: string): Promise<boolean> => {
    if (connector === "crm" || connector === "internal" || connector === "memory" || connector === "website") return true
    if (connector === "calendar") {
      const { data, error } = await service.from("shops").select("aurinko_access_token_enc,aurinko_account_id").eq("id", shopId).maybeSingle()
      return !error && Boolean(data?.aurinko_access_token_enc && data?.aurinko_account_id)
    }
    const channels = await loadChannelReadiness(service, shopId, env)
    if (!channels.ok) throw new Error("readiness unavailable")
    const key = CONNECTOR_CHANNEL[connector as keyof typeof CONNECTOR_CHANNEL]
    return key ? channels.channels[key].state === "ready" : false
  }

  return {
    grants: async (i) => {
      const grant = i.tools.find((t) => t.operation === i.operation)
      if (!grant || i.operation === "voice.outbound" || i.operation === "campaign.send") return fail("grants", "tool_not_granted")
      // Staging needs at least approval-level reach; an unapproved execute needs autonomy.
      const needed: Mode = i.intent === "execute" && !i.approvalRequired ? "autonomous" : "approval"
      return rank(grant.maximumMode) >= rank(needed) ? pass("grants") : fail("grants", "grant_mode_insufficient")
    },
    approval: async (i) => {
      if (!i.approvalRequired) return { name: "approval", status: "not_applicable" }
      if (!i.pendingActionId) return fail("approval", "approval_missing")
      const { data, error } = await service.from("pending_actions").select("status,result_id").eq("id", i.pendingActionId).eq("shop_id", i.shopId).maybeSingle()
      if (error) return fail("approval", "approval_unreadable", "unknown")
      if (!data) return fail("approval", "approval_missing")
      if (data.status !== "approved") return fail("approval", "approval_not_current")
      if (data.result_id) return fail("approval", "approval_consumed")
      return pass("approval")
    },
    readiness: async (i) => ((await readinessOf(i.shopId, ACTIONS[i.operation].connector)) ? pass("readiness") : fail("readiness", "connector_not_ready")),
    consent: async (i) => {
      const messaging = i.operation.startsWith("sms.") || i.operation.startsWith("email.")
      // Staging a draft contacts nobody; only an execute command reaches a recipient.
      if (!messaging || i.intent !== "execute") return { name: "consent", status: "not_applicable" }
      if (!i.subject) return fail("consent", "recipient_missing")
      const { data, error } = await service.from("shops").select("id,timezone,quiet_hours_start,quiet_hours_end").eq("id", i.shopId).maybeSingle()
      if (error || !data) return fail("consent", "shop_unreadable", "unknown")
      const decision = await evaluateCustomerSendPolicy(service, data as Pick<ShopRow, "id" | "timezone" | "quiet_hours_start" | "quiet_hours_end">, {
        channel: i.subject.channel, destination: i.subject.destination, customerId: i.subject.customerId, category: i.subject.category,
        body: i.subject.body, subject: i.subject.subject, serviceProof: i.subject.serviceProof ?? null, actionId: i.pendingActionId,
        nowMs: i.now?.(),
      })
      return decision.allowed ? pass("consent") : fail("consent", "send_not_permitted")
    },
    budget: async (i) => {
      // The commercial lapse gate (the same one that stops NEW paid work at the tick). The definition's own
      // per-run credit ceiling is enforced by the database in the same transaction as the attempt; the
      // legacy per-plan credit allowance does not apply to governed runs (their ceiling is the definition's).
      const gate = await assessCommercialExecution(service, i.shopId)
      return gate.allowed ? pass("budget") : fail("budget", `billing_${gate.reason}`.slice(0, 80))
    },
    policy: async (i, prior) => {
      const ctx = await loadPolicyContext(service, i.shopId)
      if (!ctx) return fail("policy", "policy_unavailable")
      // The policy the run was bound to must still be the active one (the database checks this too).
      if (i.boundPolicyRevision === null || ctx.revision !== i.boundPolicyRevision) return fail("policy", "policy_changed")
      const member = await service.from("shop_memberships").select("role,active").eq("shop_id", i.shopId).eq("user_id", ctx.ownerId).maybeSingle()
      if (member.error || member.data?.role !== "owner" || member.data.active !== true) return fail("policy", "authority_unverified")
      const definition = ACTIONS[i.operation]
      const draft = ctx.draft
      const ready = prior.readiness?.status === "pass"
      const approvalOk = prior.approval?.status === "pass"
      const decision = evaluatePolicy({
        command: {
          id: i.commandId, shopId: i.shopId, locationId: ctx.locationId, operation: i.operation, connector: definition.connector,
          intent: i.intent, source: "agent", payloadHash: i.payloadHash, stagedPolicyVersion: ctx.revision,
        },
        policy: {
          shopId: i.shopId, locationId: ctx.locationId, operation: i.operation, connector: definition.connector, version: ctx.revision,
          available: true, enabled: draft.enabled, workspaceDefault: draft.workspaceDefault, workspaceCeiling: draft.workspaceCeiling,
          connectorCeiling: draft.connectorCeilings[definition.connector] ?? "autonomous",
          actionGrant: draft.actionGrants[i.operation] ?? null, locationCeiling: draft.locationCeiling,
          roleCeiling: draft.roleCeilings.owner ?? null, riskCeiling: strictest(Object.values(draft.riskCeilings)),
          exceptionCeiling: strictest(Object.values(draft.exceptionCeilings)),
        },
        actor: { id: ctx.ownerId, shopId: i.shopId, locationId: ctx.locationId, active: true, role: "owner", authorizedOperations: [i.operation], discountLimit: 0 },
        facts: {
          tenantReferencesValid: true, safetyPassed: i.safetyVerified === true, ready, setupVerified: ready,
          causalActionVerified: i.causalActionVerified === true,
          discountAmount: null,
          approval: i.approvalRequired && approvalOk ? { commandId: i.commandId, payloadHash: i.payloadHash, policyVersion: ctx.revision, currentAuthorityVerified: true } : null,
        },
      })
      return decision.allowed ? pass("policy", { revision: ctx.revision }) : fail("policy", (decision.reasons.at(-1) ?? "denied").slice(0, 80))
    },
  }
}
