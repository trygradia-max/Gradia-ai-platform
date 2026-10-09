"use server"

import {
  qualificationCommandSchema, qualificationRefusal, qualificationSchema,
  type QualificationUpdateResult,
} from "@/lib/lead-qualification"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

/**
 * Records one reviewed qualification document for a linked intake workflow.
 * Session client only: PostgreSQL rechecks the caller's live authority and
 * commits the record and its audit row together. Ids are selectors, never
 * authorization. This never quotes, books, messages or changes consent, and an
 * uncertain result is never retried here: retry with the SAME command id.
 */
export async function updateLeadQualification(input: unknown): Promise<QualificationUpdateResult> {
  const parsed = qualificationCommandSchema.safeParse(input)
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join(".") ?? ""
    const field = path.replace(/^openQuestions/, "open_questions").replace(/\.\d+(\.|$)/g, "$1").replace(/\.$/, "")
    return { ok: false, code: "invalid", field: /^(fields|open_questions)(\.[a-z_]+)*$/.test(field) ? field : "command" }
  }
  await requireUser()
  const c = parsed.data
  const db = await createClient()
  try {
    const result = await db.rpc("update_lead_qualification", {
      p_shop: c.shopId, p_workflow: c.workflowId, p_command: c.commandId, p_revision: c.revision,
      p_customer: c.customerId, p_vehicle: c.vehicleId, p_review_state: c.reviewState,
      p_fields: c.fields, p_open_questions: c.openQuestions,
    })
    if (result.error) return qualificationRefusal(result.error)
    const status = result.data?.status
    const qualification = qualificationSchema.safeParse(result.data)
    if (!qualification.success || qualification.data.workflow_id !== c.workflowId || (status !== "recorded" && status !== "already_recorded"))
      return { ok: false, code: "not_confirmed" }
    return { ok: true, status, qualification: qualification.data }
  } catch {
    return { ok: false, code: "uncertain" }
  }
}
