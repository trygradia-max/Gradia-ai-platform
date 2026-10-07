"use server"
import { revalidatePath } from "next/cache"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { intakeVehicleLinkSchema } from "@/lib/intake-vehicle"

export async function linkIntakeVehicle(input: unknown): Promise<{ ok: boolean; message: string }> {
  const parsed = intakeVehicleLinkSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Choose and confirm a vehicle belonging to the reviewed customer." }
  await requireUser()
  const db = await createClient(), c = parsed.data
  try {
    const result = await db.rpc("link_intake_vehicle", {
      p_shop: c.shopId, p_workflow: c.workflowId, p_revision: c.revision,
      p_customer: c.customerId, p_customer_updated_at: c.customerUpdatedAt,
      p_vehicle: c.vehicle.id, p_snapshot: c.vehicle, p_command: c.commandId,
    })
    if (result.error || result.data?.workflow_id !== c.workflowId || !["linked", "already_recorded"].includes(result.data?.status)) {
      return { ok: false, message: "Vehicle link could not be confirmed. Refresh and review current access, customer and vehicle details." }
    }
    revalidatePath(`/intake/${c.workflowId}`)
    revalidatePath("/intake")
    return { ok: true, message: "Vehicle decision recorded. No message was sent; qualification has not started." }
  } catch { return { ok: false, message: "Result uncertain. Refresh history before retrying." } }
}
