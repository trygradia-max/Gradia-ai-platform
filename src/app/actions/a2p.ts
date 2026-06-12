"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import { a2pBusinessSchema, type A2pFormInput } from "@/lib/a2p-schema"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { startA2pRegistration, syncA2pStatus } from "@/lib/telephony-provider"
import type {
  A2pBusinessDetails,
  A2pRegistrationRow,
  ShopRow,
} from "@/lib/types/database"

async function resolveOrigin(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

async function loadShop(): Promise<ShopRow | null> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  return (data as ShopRow | null) ?? null
}

export type StartA2pResult = { ok: true } | { ok: false; error: string }

/** Validates the wizard form and kicks off carrier registration. */
export async function submitA2pRegistration(
  input: A2pFormInput
): Promise<StartA2pResult> {
  await requireUser()
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }

  const parsed = a2pBusinessSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form and try again.",
    }
  }

  const result = await startA2pRegistration({
    supabase: createServiceClient(),
    shop,
    business: parsed.data as A2pBusinessDetails,
    origin: await resolveOrigin(),
  })
  if (result.ok) revalidatePath("/settings")
  return result
}

export type A2pState = {
  status: A2pRegistrationRow["status"] | "none"
  failureReason: string | null
  business: A2pBusinessDetails | null
}

/** Current registration state for the wizard (no vendor calls). */
export async function getA2pState(): Promise<A2pState> {
  const shop = await loadShop()
  if (!shop) return { status: "none", failureReason: null, business: null }
  const supabase = await createClient()
  const { data } = await supabase
    .from("a2p_registrations")
    .select("*")
    .eq("shop_id", shop.id)
    .maybeSingle()
  const reg = (data as A2pRegistrationRow | null) ?? null
  if (!reg) return { status: "none", failureReason: null, business: null }
  return {
    status: reg.status,
    failureReason: reg.failure_reason,
    business: reg.business,
  }
}

/** Polls Twilio and advances the pipeline ("Check status" button). */
export async function refreshA2pStatus(): Promise<A2pState> {
  await requireUser()
  const shop = await loadShop()
  if (!shop) return { status: "none", failureReason: null, business: null }

  const result = await syncA2pStatus({
    supabase: createServiceClient(),
    shop,
    origin: await resolveOrigin(),
  })
  revalidatePath("/settings")
  return {
    status: result.status,
    failureReason: result.failureReason,
    business: null,
  }
}
