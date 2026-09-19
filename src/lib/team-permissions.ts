import { z } from "zod"

/** Supported, explicitly delegated operations. This is not an autonomy grant. */
export const TEAM_CAPABILITIES = [
  "crm.read",
  "notes.write",
  "jobs.progress",
  "assignments.manage",
] as const
export type TeamCapability = (typeof TEAM_CAPABILITIES)[number]
export type TeamRole = "owner" | "manager" | "staff"
export type TeamWorkspace = {
  id: string
  name: string
  role: TeamRole
  capabilities: TeamCapability[]
  location_id: string
}
export type TeamMember = {
  id: string
  user_id: string
  display_name: string
  role: TeamRole
  active: boolean
  capabilities: TeamCapability[]
}
export const CAPABILITY_LABELS: Record<TeamCapability, string> = {
  "crm.read": "View all shop customers and jobs",
  "notes.write": "Add customer notes",
  "jobs.progress": "Update job progress",
  "assignments.manage": "Assign visible customers and jobs to staff",
}
const id = z.string().uuid()
const grants = z.array(z.enum(TEAM_CAPABILITIES)).max(TEAM_CAPABILITIES.length)
const role = z.enum(["manager", "staff"])
export const teamCommandSchema = z
  .discriminatedUnion("operation", [
    z.object({
      operation: z.literal("invite"),
      shopId: id,
      email: z.email().max(254),
      name: z.string().trim().min(1).max(100),
      role,
      capabilities: grants,
    }),
    z.object({
      operation: z.literal("member"),
      shopId: id,
      memberId: id,
      role,
      active: z.boolean(),
      capabilities: grants,
    }),
    z.object({ operation: z.literal("cancel"), shopId: id, invitationId: id }),
    z.object({
      operation: z.literal("accept"),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    z.object({
      operation: z.literal("assign"),
      shopId: id,
      memberId: id,
      customerId: id.nullable(),
      appointmentId: id.nullable(),
      remove: z.boolean(),
    }),
    z.object({
      operation: z.literal("note"),
      shopId: id,
      customerId: id,
      content: z.string().trim().min(1).max(4000),
    }),
    z.object({
      operation: z.literal("progress"),
      shopId: id,
      appointmentId: id,
      expected: z.string().max(30),
      status: z.enum(["checked_in", "in_progress", "on_hold", "completed"]),
    }),
  ])
  .superRefine((command, ctx) => {
    if (
      (command.operation === "invite" || command.operation === "member") &&
      command.role === "staff" &&
      command.capabilities.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Staff cannot receive manager grants",
      })
    if (
      command.operation === "assign" &&
      Boolean(command.customerId) === Boolean(command.appointmentId)
    )
      ctx.addIssue({ code: "custom", message: "Choose one record" })
  })
export type TeamCommand = z.infer<typeof teamCommandSchema>

/** UI/server precheck only. PostgreSQL independently rechecks live membership. */
export function canTeamCommand(
  workspace: TeamWorkspace,
  command: Exclude<TeamCommand, { operation: "accept" }>
): boolean {
  if (workspace.id !== command.shopId) return false
  if (workspace.role === "owner") return true
  if (["invite", "member", "cancel"].includes(command.operation)) return false
  if (command.operation === "assign")
    return (
      workspace.role === "manager" &&
      workspace.capabilities.includes("assignments.manage")
    )
  if (command.operation === "note")
    return (
      workspace.role === "staff" ||
      workspace.capabilities.includes("notes.write")
    )
  if (command.operation === "progress")
    return (
      workspace.role === "staff" ||
      workspace.capabilities.includes("jobs.progress")
    )
  return false
}
export const nextJobStatuses: Record<string, string[]> = {
  booked: ["checked_in"],
  confirmed: ["checked_in"],
  checked_in: ["in_progress"],
  in_progress: ["on_hold", "completed"],
  on_hold: ["in_progress"],
}
