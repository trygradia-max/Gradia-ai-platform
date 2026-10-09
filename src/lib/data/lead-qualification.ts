import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  qualificationHistorySchema, qualificationListSchema, qualificationSchema,
  type LeadQualification, type LeadQualificationHistory, type LeadQualificationList,
} from "@/lib/lead-qualification"

const id = z.string().uuid()
const page = (offset: number) => Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000
type Read<T> = { ok: true; data: T } | { ok: false }

/** Session client only; PostgreSQL independently verifies current authority.
 *  A failed or malformed read is never reported as an empty qualification. */
export async function loadLeadQualification(db: SupabaseClient, shopId: string, workflowId: string): Promise<Read<LeadQualification>> {
  if (!id.safeParse(shopId).success || !id.safeParse(workflowId).success) return { ok: false }
  try {
    const result = await db.rpc("read_lead_qualification", { p_shop: shopId, p_workflow: workflowId })
    const parsed = result.error ? null : qualificationSchema.safeParse(result.data)
    return parsed?.success ? { ok: true, data: parsed.data } : { ok: false }
  } catch { return { ok: false } }
}

export async function loadLeadQualifications(db: SupabaseClient, shopId: string, offset = 0): Promise<Read<LeadQualificationList>> {
  if (!id.safeParse(shopId).success || !page(offset)) return { ok: false }
  try {
    const result = await db.rpc("list_lead_qualifications", { p_shop: shopId, p_offset: offset })
    const parsed = result.error ? null : qualificationListSchema.safeParse(result.data)
    return parsed?.success ? { ok: true, data: parsed.data } : { ok: false }
  } catch { return { ok: false } }
}

export async function loadLeadQualificationHistory(db: SupabaseClient, shopId: string, workflowId: string, offset = 0): Promise<Read<LeadQualificationHistory>> {
  if (!id.safeParse(shopId).success || !id.safeParse(workflowId).success || !page(offset)) return { ok: false }
  try {
    const result = await db.rpc("read_lead_qualification_history", { p_shop: shopId, p_workflow: workflowId, p_offset: offset })
    const parsed = result.error ? null : qualificationHistorySchema.safeParse(result.data)
    return parsed?.success ? { ok: true, data: parsed.data } : { ok: false }
  } catch { return { ok: false } }
}
