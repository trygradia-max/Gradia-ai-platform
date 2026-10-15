"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import {
  canTeamCommand,
  teamCommandSchema,
  type TeamWorkspace,
} from "@/lib/team-permissions"

export type TeamResult = { ok: boolean; message: string; token?: string }

/** Session client only: no service-role bypass, caller-supplied actor or provider. */
export async function runTeamCommand(input: unknown): Promise<TeamResult> {
  const parsed = teamCommandSchema.safeParse(input)
  if (!parsed.success)
    return {
      ok: false,
      message: "Check the required fields and permitted role settings.",
    }
  const db = await createClient()
  const {
    data: { user },
    error: authError,
  } = await db.auth.getUser()
  if (authError || !user)
    return { ok: false, message: "Sign in again before changing shop data." }
  const c = parsed.data
  if (c.operation !== "accept") {
    const { data, error } = await db.rpc("team_workspaces")
    const workspace = (
      Array.isArray(data) ? (data as TeamWorkspace[]) : []
    ).find((w) => w.id === c.shopId)
    if (error || !workspace || !canTeamCommand(workspace, c))
      return {
        ok: false,
        message: "Your current membership does not permit this action.",
      }
  }
  // Database RPCs lock the shop, recheck permissions and commit audit atomically.
  const result =
    c.operation === "accept"
      ? await db.rpc("team_accept_invite", { p_token: c.token })
      : c.operation === "invite"
        ? await db.rpc("team_invite", {
            p_shop: c.shopId,
            p_email: c.email,
            p_name: c.name,
            p_role: c.role,
            p_capabilities: c.capabilities,
          })
        : c.operation === "member"
          ? await db.rpc("team_set_member", {
              p_shop: c.shopId,
              p_member: c.memberId,
              p_role: c.role,
              p_active: c.active,
              p_capabilities: c.capabilities,
            })
          : c.operation === "cancel"
            ? await db.rpc("team_cancel_invite", {
                p_shop: c.shopId,
                p_invitation: c.invitationId,
              })
            : c.operation === "assign"
              ? await db.rpc("team_assign", {
                  p_shop: c.shopId,
                  p_member: c.memberId,
                  p_customer: c.customerId,
                  p_appointment: c.appointmentId,
                  p_remove: c.remove,
                })
              : c.operation === "note"
                ? await db.rpc("team_add_note", {
                    p_shop: c.shopId,
                    p_customer: c.customerId,
                    p_content: c.content,
                  })
                : await db.rpc("team_job_progress", {
                    p_shop: c.shopId,
                    p_appointment: c.appointmentId,
                    p_expected: c.expected,
                    p_status: c.status,
                  })
  if (result.error)
    return {
      ok: false,
      message:
        "No changes saved. Access, invitation or record state may have changed. Refresh and check with the owner.",
    }
  revalidatePath("/team")
  revalidatePath("/customers")
  revalidatePath("/calendar")
  return {
    ok: true,
    message:
      c.operation === "invite"
        ? "Invitation created. No email was sent. Share the code securely; it expires in 7 days."
        : "Saved.",
    ...(c.operation === "invite"
      ? { token: (result.data as { token: string }).token }
      : {}),
  }
}
