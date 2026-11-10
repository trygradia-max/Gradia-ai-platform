import { ACTIONS, modes, type Connector, type Mode, type Operation } from "@/lib/control-center/policy"
import type { AgentSummaryDto, DefinitionLifecycle, MemoryPinDto, RevisionRef } from "@/lib/agent-os/definition-dto"
import type { AgentDefinitionDraft } from "@/lib/agent-os/definition-schema"

/** Owner-facing names for every Control Center operation. Keyed by the full catalog (compile + test locked). */
export const OPERATION_LABELS: Record<Operation, { label: string; help: string }> = {
  "crm.read": { label: "Look up customers and leads", help: "Read customer, lead and job records." },
  "history.read": { label: "Read conversation history", help: "Read past messages and calls for a customer." },
  "menu.read": { label: "Read your services and prices", help: "Read the service menu." },
  "availability.read": { label: "Check calendar availability", help: "Read open times on your calendar." },
  "draft.private": { label: "Draft notes privately", help: "Write drafts only your team can see." },
  "memory.propose": { label: "Suggest knowledge to remember", help: "Propose a note for review. Nothing is remembered until a person approves it." },
  "intake.capture": { label: "Capture new inquiries", help: "Turn an inbound message into a lead record." },
  "identity.deduplicate": { label: "Match repeat customers", help: "Link an inquiry to an existing customer record." },
  "identity.review": { label: "Flag possible duplicates", help: "Queue a possible duplicate for a person to review." },
  "customer.merge": { label: "Merge customer records", help: "Combine two records. Always needs the owner's approval." },
  "sms.reply": { label: "Reply to texts", help: "Draft or send a text reply." },
  "sms.qualify": { label: "Qualify leads by text", help: "Ask follow-up questions by text." },
  "sms.nurture": { label: "Keep leads warm by text", help: "Send a follow-up text to a quiet lead." },
  "email.reply": { label: "Reply to emails", help: "Draft or send an email reply." },
  "email.qualify": { label: "Qualify leads by email", help: "Ask follow-up questions by email." },
  "email.nurture": { label: "Keep leads warm by email", help: "Send a follow-up email to a quiet lead." },
  "voice.inbound": { label: "Answer phone calls", help: "Answer inbound calls." },
  "voice.outbound": { label: "Place phone calls", help: "Not available yet." },
  "quote.send": { label: "Send quotes", help: "Send a quote to a customer. A person approves first." },
  "booking.create": { label: "Book appointments", help: "Put an appointment on the calendar. A person approves first." },
  "quote.discount": { label: "Offer discounts", help: "Change a quote price. A person approves first." },
  "booking.reschedule": { label: "Reschedule appointments", help: "Move an appointment. A person approves first." },
  "booking.cancel": { label: "Cancel appointments", help: "Cancel an appointment. A person approves first." },
  "sms.confirm": { label: "Confirm appointments by text", help: "Text a booking confirmation." },
  "sms.remind": { label: "Remind customers by text", help: "Text an appointment reminder." },
  "sms.followup": { label: "Follow up after a job by text", help: "Text a thank-you or follow-up." },
  "email.confirm": { label: "Confirm appointments by email", help: "Email a booking confirmation." },
  "email.remind": { label: "Remind customers by email", help: "Email an appointment reminder." },
  "email.followup": { label: "Follow up after a job by email", help: "Email a thank-you or follow-up." },
  "crm.edit": { label: "Edit customer records", help: "Change a customer or lead record." },
  "assignment.change": { label: "Reassign work", help: "Change who owns a lead or job." },
  "pipeline.change": { label: "Move leads between stages", help: "Change a lead's pipeline stage." },
  "pipeline.mechanical": { label: "Update stages automatically", help: "Apply routine stage changes caused by a confirmed event." },
  "evidence.record": { label: "Record what happened", help: "Write evidence to the activity log." },
  "memory.publish.customer": { label: "Publish customer notes", help: "Publish a reviewed customer note. Needs approval." },
  "memory.publish.shop": { label: "Publish shop knowledge", help: "Publish reviewed shop knowledge. Owner approval only." },
  "manager.notify": { label: "Notify a manager", help: "Email a manager about something that needs attention." },
  "campaign.send": { label: "Send campaigns", help: "Not available yet." },
}

export const POST_MVP_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>(["voice.outbound", "campaign.send"])

export const MODE_LABELS: Record<Mode, string> = {
  off: "Off",
  read: "Read only",
  suggest: "Suggest only",
  approval: "Needs approval",
  autonomous: "Automatic",
}

export const MODE_HELP: Record<Mode, string> = {
  off: "Gradia will not do this.",
  read: "Gradia may look at the information but not change anything.",
  suggest: "Gradia may draft or propose. Nothing leaves your workspace.",
  approval: "Gradia prepares the action and waits for a person to approve it.",
  autonomous: "Gradia may act and log what it did.",
}

export const CONNECTOR_LABELS: Record<Connector, string> = {
  crm: "Your customer records",
  sms: "Texting",
  email: "Email",
  voice: "Phone calls",
  calendar: "Calendar",
  memory: "Reviewed knowledge",
  internal: "Gradia workspace",
  website: "Website",
  meta: "Facebook and Instagram leads",
}

/** The highest mode a requested grant may take for an operation, per the existing definition schema. */
export function maximumModeChoices(operation: Operation): Mode[] {
  const initial = ACTIONS[operation].initial
  if (initial === "read" || initial === "suggest") return modes.filter((mode) => modes.indexOf(mode) <= modes.indexOf(initial)) as Mode[]
  return [...modes]
}

export function defaultMaximumMode(operation: Operation): Mode {
  const initial = ACTIONS[operation].initial
  return initial === "off" ? "suggest" : initial === "autonomous" ? "approval" : initial
}

/** Finite Control Center / readiness reasons, in owner language. Unknown reasons are shown generically, never hidden. */
const TOOL_REASONS: Record<string, string> = {
  policy_unavailable: "No Control Center policy is published yet.",
  channel_not_ready: "The connection this tool needs is not set up.",
  workspace_disabled: "Control Center has agent actions turned off for your workspace.",
  operation_disabled: "Control Center has this action turned off.",
  post_mvp_disabled: "This action is not available yet.",
  owner_required: "Only the owner can use this action.",
  staff_operation_forbidden: "This action is not available to staff.",
  actor_not_authorized: "You are not authorized for this action.",
  explicit_autonomy_grant_required: "Automatic mode needs an explicit grant in Control Center.",
  hard_approval_floor: "This action always needs a person's approval.",
  current_bound_approval_required: "This action needs a person's approval each time.",
  execution_not_permitted: "This tool can read or draft only.",
  intent_not_permitted: "Control Center does not permit this.",
  safety_not_verified: "A safety check could not be confirmed.",
  scope_mismatch: "Workspace scope could not be confirmed.",
  explicit_action_grant: "Allowed by an explicit Control Center grant.",
  workspace_default: "Allowed by your workspace default.",
  approved_initial_default: "Allowed by Gradia's reviewed default.",
}

export function describeToolReason(code: string): string {
  if (TOOL_REASONS[code]) return TOOL_REASONS[code]
  if (/^[a-z_]+_ceiling$/.test(code)) return "Capped by a Control Center ceiling."
  return "A Control Center rule applies."
}

export const LIFECYCLE_LABELS: Record<DefinitionLifecycle | "legacy_unversioned", { label: string; tone: "good" | "warn" | "bad" | "accent" | "muted"; help: string }> = {
  draft: { label: "Draft", tone: "accent", help: "Saved revisions exist, but none is active." },
  active: { label: "Active", tone: "good", help: "One saved revision is the active definition." },
  paused: { label: "Paused", tone: "warn", help: "Paused by the owner. Resuming is a fresh activation with fresh checks." },
  blocked: { label: "Blocked", tone: "bad", help: "Blocked by the owner. Resuming is a fresh activation with fresh checks." },
  legacy_unversioned: { label: "Legacy", tone: "muted", help: "Created before saved revisions. Not governed by a definition yet." },
}

export function governanceLabel(governance: AgentSummaryDto["governance"]): string {
  return governance === "governed" ? "Governed" : "Legacy"
}

export const PIN_STATUS_LABELS: Record<MemoryPinDto["status"], { label: string; tone: "good" | "warn" | "bad" | "muted"; help: string }> = {
  current: { label: "Current", tone: "good", help: "Still the published, unexpired revision that was pinned." },
  revoked: { label: "Revoked", tone: "bad", help: "This source was revoked or removed." },
  changed: { label: "Changed", tone: "bad", help: "This source is no longer the reviewed text that was pinned." },
  stale: { label: "Newer version exists", tone: "warn", help: "A newer revision was published after this one was pinned." },
  expired: { label: "Expired", tone: "warn", help: "This source is outside its review or retention window." },
}

export const EVENT_LABELS: Record<Extract<AgentDefinitionDraft["schedule"], { kind: "event" }>["event"], { label: string; code: string }> = {
  "lead.received": { label: "A new lead arrives", code: "lead.received" },
  "message.received": { label: "A customer message arrives", code: "message.received" },
  "appointment.changed": { label: "An appointment is booked, moved or canceled", code: "appointment.changed" },
  "approval.resolved": { label: "A person approves or dismisses something", code: "approval.resolved" },
}

export function describeSchedule(schedule: AgentDefinitionDraft["schedule"]): string {
  if (schedule.kind === "manual") return "Manual only. It runs when a person starts it."
  if (schedule.kind === "event") return `When: ${EVENT_LABELS[schedule.event].label}.`
  return `Every ${formatInterval(schedule.everyMinutes)}.`
}

export function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "day" : `${minutes / 1440} days`
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`
  return `${minutes} minutes`
}

export const shortHash = (hash: string | null | undefined): string => (hash ? hash.slice(0, 10) : "unknown")

export function revisionLabel(ref: Pick<RevisionRef, "revision"> | null | undefined): string {
  return ref ? `Revision ${ref.revision}` : "None"
}
