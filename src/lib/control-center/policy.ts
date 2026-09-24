/**
 * Control Center policy contract. Not a runtime authorization boundary yet.
 * Only trusted server adapters may construct facts; models/request bodies never
 * grant actor, consent, readiness or approval authority. Existing executors remain
 * authoritative until each path is migrated with integration coverage.
 */
import { z } from "zod"

export const modes = ["off", "read", "suggest", "approval", "autonomous"] as const
export type Mode = (typeof modes)[number]
const mode = z.enum(modes)
const ceiling = mode.nullable() // null explicitly means inherit, never autonomous
const id = z.string().uuid()
const operations = [
  "crm.read", "history.read", "menu.read", "availability.read",
  "draft.private", "memory.propose", "intake.capture", "identity.deduplicate",
  "identity.review", "customer.merge", "sms.reply", "sms.qualify", "sms.nurture",
  "email.reply", "email.qualify", "email.nurture", "voice.inbound", "voice.outbound",
  "quote.send", "booking.create", "quote.discount", "booking.reschedule",
  "booking.cancel", "sms.confirm", "sms.remind", "sms.followup", "email.confirm",
  "email.remind", "email.followup", "crm.edit", "assignment.change", "pipeline.change",
  "pipeline.mechanical", "evidence.record", "memory.publish.customer",
  "memory.publish.shop", "manager.notify", "campaign.send",
] as const
export type Operation = (typeof operations)[number]
export type Connector = "crm" | "sms" | "email" | "voice" | "calendar" | "memory" | "internal" | "website" | "meta"
type Definition = { connector: Connector; connectorOptions?: readonly Connector[]; initial: Mode; ownerOnly?: boolean; setup?: boolean; hardApproval?: boolean }
const approval = (connector: Connector, extra: Partial<Definition> = {}): Definition => ({ connector, initial: "approval", ...extra })
export const ACTIONS: Readonly<Record<Operation, Definition>> = {
  "crm.read": { connector: "crm", initial: "read" },
  "history.read": { connector: "crm", initial: "read" },
  "menu.read": { connector: "crm", initial: "read" },
  "availability.read": { connector: "calendar", initial: "read" },
  "draft.private": { connector: "internal", initial: "suggest" },
  "memory.propose": { connector: "memory", initial: "suggest" },
  "intake.capture": { connector: "crm", connectorOptions: ["crm", "sms", "email", "voice", "website", "meta"], initial: "autonomous", setup: true },
  "identity.deduplicate": { connector: "crm", connectorOptions: ["crm", "sms", "email", "voice", "website", "meta"], initial: "autonomous", setup: true },
  "identity.review": approval("crm"),
  "customer.merge": approval("crm", { ownerOnly: true, hardApproval: true }),
  "sms.reply": approval("sms"), "sms.qualify": approval("sms"), "sms.nurture": approval("sms"),
  "email.reply": approval("email"), "email.qualify": approval("email"), "email.nurture": approval("email"),
  "voice.inbound": { connector: "voice", initial: "off", setup: true },
  "voice.outbound": { connector: "voice", initial: "off" },
  "quote.send": approval("crm", { hardApproval: true }),
  "booking.create": approval("calendar", { hardApproval: true }),
  "quote.discount": approval("crm", { hardApproval: true }),
  "booking.reschedule": approval("calendar", { hardApproval: true }),
  "booking.cancel": approval("calendar", { hardApproval: true }),
  "sms.confirm": approval("sms"), "sms.remind": approval("sms"), "sms.followup": approval("sms"),
  "email.confirm": approval("email"), "email.remind": approval("email"), "email.followup": approval("email"),
  "crm.edit": approval("crm"), "assignment.change": approval("crm"), "pipeline.change": approval("crm"),
  "pipeline.mechanical": { connector: "crm", initial: "autonomous" },
  "evidence.record": { connector: "internal", initial: "autonomous" },
  "memory.publish.customer": approval("memory", { hardApproval: true }),
  "memory.publish.shop": approval("memory", { ownerOnly: true, hardApproval: true }),
  "manager.notify": { connector: "email", initial: "autonomous", setup: true },
  "campaign.send": { connector: "sms", initial: "off" },
}

export const policyInputSchema = z.object({
  command: z.object({
    id, shopId: id, locationId: id, operation: z.enum(operations),
    connector: z.enum(["crm", "sms", "email", "voice", "calendar", "memory", "internal", "website", "meta"]),
    intent: z.enum(["read", "suggest", "stage", "execute"]),
    source: z.enum(["human", "agent", "automation"]),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    stagedPolicyVersion: z.number().int().positive().nullable(),
  }).strict(),
  policy: z.object({
    shopId: id, locationId: id, operation: z.enum(operations), connector: z.enum(["crm", "sms", "email", "voice", "calendar", "memory", "internal", "website", "meta"]), version: z.number().int().positive(),
    available: z.boolean(), enabled: z.boolean(),
    workspaceDefault: ceiling, workspaceCeiling: mode,
    connectorCeiling: mode, actionGrant: ceiling,
    locationCeiling: ceiling, roleCeiling: ceiling, riskCeiling: ceiling, exceptionCeiling: ceiling,
  }).strict(),
  actor: z.object({
    id, shopId: id, locationId: id, active: z.boolean(),
    role: z.enum(["owner", "manager", "staff"]),
    authorizedOperations: z.array(z.enum(operations)),
    // Resolved independently from proposed discount; zero is the default grant.
    discountLimit: z.number().finite().min(0),
  }).strict(),
  facts: z.object({
    tenantReferencesValid: z.boolean(), safetyPassed: z.boolean(),
    ready: z.boolean(), setupVerified: z.boolean(),
    causalActionVerified: z.boolean(),
    discountAmount: z.number().finite().min(0).nullable(),
    approval: z.object({
      commandId: id, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
      policyVersion: z.number().int().positive(),
      currentAuthorityVerified: z.boolean(),
    }).strict().nullable(),
  }).strict(),
}).strict()
export type PolicyInput = z.infer<typeof policyInputSchema>
export type PolicyDecision = {
  allowed: boolean
  mode: Mode
  reasons: string[]
  policyVersion: number | null
  stagedPolicyVersion: number | null
}
const rank = (m: Mode) => modes.indexOf(m)

/** Pure, fail-closed decision. This never persists a draft, claims a proof or sends. */
export function evaluatePolicy(input: unknown): PolicyDecision {
  const parsed = policyInputSchema.safeParse(input)
  if (!parsed.success) return { allowed: false, mode: "off", reasons: ["invalid_contract"], policyVersion: null, stagedPolicyVersion: null }
  const { command: c, policy: p, actor: a, facts: f } = parsed.data
  const d = ACTIONS[c.operation]
  const result: PolicyDecision = { allowed: false, mode: "off", reasons: [], policyVersion: p.version, stagedPolicyVersion: c.stagedPolicyVersion }
  const deny = (why: string) => ({ ...result, reasons: [...result.reasons, why] })
  if (!p.available) return deny("policy_unavailable")
  if (c.shopId !== p.shopId || c.shopId !== a.shopId || c.locationId !== p.locationId || c.locationId !== a.locationId) return deny("scope_mismatch")
  if (p.connector !== c.connector) return deny("connector_policy_mismatch")
  if (p.operation !== c.operation) return deny("action_policy_mismatch")
  if (!(d.connectorOptions ?? [d.connector]).includes(c.connector)) return deny("connector_mismatch")
  if (!a.active || !a.authorizedOperations.includes(c.operation)) return deny("actor_not_authorized")
  if (a.role === "staff" && d.initial !== "read" && c.operation !== "memory.propose" && c.operation !== "draft.private") return deny("staff_operation_forbidden")
  if (d.ownerOnly && a.role !== "owner") return deny("owner_required")
  if (c.operation === "voice.outbound" || c.operation === "campaign.send") return deny("post_mvp_disabled")
  if (!f.tenantReferencesValid || !f.safetyPassed) return deny("safety_not_verified")
  if (!p.enabled) return deny("workspace_disabled")
  if (!f.ready || (d.setup && !f.setupVerified)) return deny("channel_not_ready")
  if (c.operation === "pipeline.mechanical" && !f.causalActionVerified) return deny("causation_not_verified")
  if (c.operation === "quote.discount" && (f.discountAmount === null || (a.role !== "owner" && f.discountAmount > a.discountLimit))) return deny("discount_not_authorized")
  let effective = p.actionGrant ?? p.workspaceDefault ?? d.initial
  if (effective === "autonomous" && d.initial !== "autonomous" && p.actionGrant !== "autonomous") return deny("explicit_autonomy_grant_required")
  result.reasons.push(p.actionGrant !== null ? "explicit_action_grant" : p.workspaceDefault !== null ? "workspace_default" : "approved_initial_default")
  for (const [name, cap] of Object.entries({ workspace: p.workspaceCeiling, connector: p.connectorCeiling, location: p.locationCeiling, role: p.roleCeiling, risk: p.riskCeiling, exception: p.exceptionCeiling })) {
    if (cap !== null && rank(cap) < rank(effective)) { effective = cap; result.reasons.push(`${name}_ceiling`) }
  }
  // No setting can turn a read/draft operation into a domain write.
  if ((d.initial === "read" || d.initial === "suggest") && rank(effective) > rank(d.initial)) effective = d.initial
  // Existing calendar/money and reviewed-memory floors remain until replacement acceptance.
  if (d.hardApproval && effective === "autonomous") { effective = "approval"; result.reasons.push("hard_approval_floor") }
  result.mode = effective
  if (effective === "off") return deny("operation_disabled")
  if (c.intent === "read") {
    result.allowed = d.initial === "read"
  } else if (c.intent === "suggest") {
    result.allowed = rank(effective) >= rank("suggest")
  } else if (c.intent === "stage") {
    result.allowed = rank(effective) >= rank("approval")
  } else {
    if (d.initial === "read" || d.initial === "suggest" || rank(effective) < rank("approval")) return deny("execution_not_permitted")
    // A direct human command uses current human authority, without a second approval.
    const approved = f.approval !== null && f.approval.commandId === c.id && f.approval.payloadHash === c.payloadHash && f.approval.policyVersion === p.version && f.approval.currentAuthorityVerified
    result.allowed = c.source === "human" || effective === "autonomous" || approved
    if (!result.allowed) result.reasons.push("current_bound_approval_required")
  }
  if (!result.allowed && !result.reasons.includes("current_bound_approval_required")) result.reasons.push("intent_not_permitted")
  return result
}

/** Legacy suggest meant executable HITL staging, not private SUGGEST. */
export function translateLegacyMode(value: unknown): Mode {
  return value === "suggest" || value === "autonomous" ? "approval" : "off"
}
