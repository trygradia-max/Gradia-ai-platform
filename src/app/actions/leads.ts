"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { sendLeadAlert } from "@/lib/slack"
import { requireShop } from "@/lib/shop"

const createLeadSchema = z.object({
  customerName: z.string().min(1, "Name is required").max(200),
  phone: z.string().min(5).max(40),
  carInfo: z.string().max(500).optional().nullable(),
  pinNotes: z.string().max(2000).optional().nullable(),
  status: z.enum(["new", "quoted", "booked"]).optional(),
})

export type CreateLeadResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

export async function createLead(
  input: z.infer<typeof createLeadSchema>
): Promise<CreateLeadResult> {
  const parsed = createLeadSchema.safeParse(input)
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

  const { error } = await supabase.from("leads").insert({
    shop_id: shop.id,
    customer_name: parsed.data.customerName,
    phone: parsed.data.phone,
    car_info: parsed.data.carInfo ?? null,
    pin_notes: parsed.data.pinNotes ?? null,
    status: parsed.data.status ?? "new",
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  revalidatePath("/dashboard")
  revalidatePath("/leads")

  try {
    await sendLeadAlert({
      customerName: parsed.data.customerName,
      phone: parsed.data.phone,
      carInfo: parsed.data.carInfo ?? null,
    })
  } catch (slackErr) {
    console.error("[slack] sendLeadAlert:", slackErr)
  }

  return { ok: true }
}
