"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { getOptionalShop, requireUser } from "@/lib/shop"

const createShopSchema = z.object({
  name: z.string().min(1, "Shop name is required").max(120),
})

export type CreateShopResult =
  | { ok: true }
  | { ok: false; error: string }

export async function createShop(input: {
  name: string
}): Promise<CreateShopResult> {
  const parsed = createShopSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.flatten().formErrors.join(", ") || "Invalid input",
    }
  }

  const existing = await getOptionalShop()
  if (existing) {
    redirect("/dashboard")
  }

  const user = await requireUser()
  const supabase = await createClient()

  const { error } = await supabase.from("shops").insert({
    name: parsed.data.name.trim(),
    owner_id: user.id,
    settings: {},
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  revalidatePath("/", "layout")
  redirect("/dashboard")
}
