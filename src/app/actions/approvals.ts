"use server"

import { revalidatePath } from "next/cache"

import { executeApproval, executeRejection } from "@/lib/approvals"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export type DashboardDecisionResult =
  | { ok: true; alreadyDecided: boolean }
  | { ok: false; error: string }

export async function approveFromDashboard(
  pendingId: string
): Promise<DashboardDecisionResult> {
  const user = await requireUser()
  const supabase = await createClient()
  const result = await executeApproval(supabase, pendingId, { userId: user.id })

  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  revalidatePath("/dashboard")
  revalidatePath("/leads")
  revalidatePath("/approvals")
  return { ok: true, alreadyDecided: result.status === "already_decided" }
}

export async function rejectFromDashboard(
  pendingId: string
): Promise<DashboardDecisionResult> {
  const user = await requireUser()
  const supabase = await createClient()
  const result = await executeRejection(supabase, pendingId, { userId: user.id })

  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  revalidatePath("/approvals")
  return { ok: true, alreadyDecided: result.status === "already_decided" }
}
