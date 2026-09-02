"use server"

import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"

const submitLeadSchema = z.object({
  customerName: z.string().min(1, "Name is required").max(200),
  phone: z.string().min(5).max(40),
  carInfo: z.string().max(500).optional().nullable(),
  pinNotes: z.string().max(2000).optional().nullable(),
  status: z.enum(["new", "quoted", "booked"]).optional(),
})

export type CreateLeadResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/**
 * Submits a proposed lead for human approval. Nothing is written to `leads`
 * until someone clicks Approve in /approvals — the dashboard action handles
 * the insert.
 */
export async function createLead(
  input: z.infer<typeof submitLeadSchema>
): Promise<CreateLeadResult> {
  const parsed = submitLeadSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    }
  }

  const shop = await requireShop()
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: "Sign-in expired — please refresh." }
  }

  const status = parsed.data.status ?? "new"
  const carInfo = parsed.data.carInfo ?? null
  const pinNotes = parsed.data.pinNotes ?? null

  const proposal = {
    customer_name: parsed.data.customerName,
    phone: parsed.data.phone,
    car_info: carInfo,
    pin_notes: pinNotes,
    status,
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "create_lead",
      payload: proposal,
      requested_by: user.id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    return {
      ok: false,
      error: pendingErr?.message ?? "Could not queue lead for approval.",
    }
  }

  return { ok: true }
}
