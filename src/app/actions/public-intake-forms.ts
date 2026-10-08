"use server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { publicFormConfigurationSchema, publicFormResultSchema } from "@/lib/public-form-intake"

// Session-only RPCs enforce the current active owner; no service-role fallback.
export async function configurePublicIntakeForm(input: unknown) {
  const parsed = publicFormConfigurationSchema.safeParse(input)
  if (!parsed.success) return { ok: false as const, message: "Check the form configuration." }
  const c = parsed.data
  try {
    const db = await createClient()
    const result = await db.rpc("configure_public_intake_form", { p_shop: c.shopId, p_form: c.formId, p_origin: c.origin, p_enabled: c.enabled, p_revision: c.revision })
    const form = result.error ? null : publicFormResultSchema.safeParse(result.data)
    if (!form?.success || form.data.id !== c.formId || form.data.shop_id !== c.shopId || form.data.revision !== c.revision + 1 || form.data.allowed_origin !== c.origin || form.data.enabled !== c.enabled) {
      return { ok: false as const, message: "Configuration could not be confirmed. Refresh before retrying." }
    }
    return { ok: true as const, form: form.data }
  } catch { return { ok: false as const, message: "Configuration could not be confirmed. Refresh before retrying." } }
}

export async function listPublicIntakeForms(shopId: string) {
  if (!z.string().uuid().safeParse(shopId).success) return { ok: false as const }
  try {
    const db = await createClient()
    const result = await db.rpc("list_public_intake_forms", { p_shop: shopId })
    const forms = result.error ? null : z.array(publicFormResultSchema).safeParse(result.data)
    if (!forms?.success || forms.data.some(f => f.shop_id !== shopId)) return { ok: false as const }
    return { ok: true as const, forms: forms.data }
  } catch { return { ok: false as const } }
}
