import { z } from "zod"
import { ACTIONS, modes } from "./policy"

export const connectors = ["crm", "sms", "email", "voice", "calendar", "memory", "internal", "website", "meta"] as const
export const risks = ["routine", "elevated", "high"] as const
export const exceptions = ["unknown_identity", "stale_calendar", "outside_hours", "price_exception"] as const
const mode = z.enum(modes)
const overrides = (keys: readonly string[]) => z.record(z.string(), mode.nullable()).superRefine((record, ctx) => {
  for (const key of Object.keys(record)) if (!keys.includes(key)) ctx.addIssue({ code: "custom", message: "Unknown policy scope", path: [key] })
})
/** Stored plans only. Activating an execution policy is a different, unimplemented operation. */
export const policyDraftSchema = z.object({
  enabled: z.boolean(),
  workspaceDefault: mode.nullable(),
  workspaceCeiling: mode,
  locationCeiling: mode.nullable(),
  connectorCeilings: overrides(connectors),
  actionGrants: overrides(Object.keys(ACTIONS)),
  roleCeilings: overrides(["owner", "manager", "staff"]),
  riskCeilings: overrides(risks),
  exceptionCeilings: overrides(exceptions),
}).strict()
export type PolicyDraft = z.infer<typeof policyDraftSchema>
export const initialPolicyDraft = (): PolicyDraft => ({
  enabled: true, workspaceDefault: null, workspaceCeiling: "autonomous", locationCeiling: null,
  connectorCeilings: {}, actionGrants: {}, roleCeilings: {}, riskCeilings: {}, exceptionCeilings: {},
})
export const draftSaveSchema = z.object({
  shopId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  definition: policyDraftSchema,
}).strict()

export const operationLabels: Record<keyof typeof ACTIONS, string> = {
  "crm.read": "Read customers and jobs", "history.read": "Read communication history",
  "menu.read": "Read the service menu", "availability.read": "Read availability",
  "draft.private": "Prepare a private draft", "memory.propose": "Propose a memory update",
  "intake.capture": "Capture a verified lead", "identity.deduplicate": "Match duplicate identities",
  "identity.review": "Review an ambiguous identity", "customer.merge": "Merge customers",
  "sms.reply": "Reply by SMS", "sms.qualify": "Qualify a lead by SMS", "sms.nurture": "Nurture by SMS",
  "email.reply": "Reply by email", "email.qualify": "Qualify a lead by email", "email.nurture": "Nurture by email",
  "voice.inbound": "Handle inbound calls", "voice.outbound": "Make outbound calls",
  "quote.send": "Send a quote", "booking.create": "Create a booking", "quote.discount": "Approve a discount",
  "booking.reschedule": "Reschedule a booking", "booking.cancel": "Cancel a booking",
  "sms.confirm": "Send an SMS confirmation", "sms.remind": "Send an SMS reminder", "sms.followup": "Follow up by SMS",
  "email.confirm": "Send an email confirmation", "email.remind": "Send an email reminder", "email.followup": "Follow up by email",
  "crm.edit": "Propose customer record changes", "assignment.change": "Propose work assignments", "pipeline.change": "Propose pipeline changes",
  "pipeline.mechanical": "Record an authorized action in the pipeline", "evidence.record": "Record operational evidence",
  "memory.publish.customer": "Publish customer-specific memory", "memory.publish.shop": "Publish shop-wide memory",
  "manager.notify": "Notify a manager", "campaign.send": "Send a campaign",
}
