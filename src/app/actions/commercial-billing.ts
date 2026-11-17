"use server"

import {
  isReturnTarget,
  blockedDto,
  type CommercialBillingDto,
} from "@/lib/commercial-billing"
import {
  readCommercialBillingDto,
  requestCommercialBillingPortal,
  requestFounderPilotCheckout,
  resolveBillingRuntime,
  resolvePortalRuntime,
  type PortalResult,
} from "@/lib/commercial-billing-service"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Founder Pilot billing handoff (sandbox/test mode only). Server Functions are
 * reachable by direct POST, so authority is derived HERE and re-verified by the
 * database; nothing about the shop, the user or any URL is taken from the caller.
 *
 * The only client input is an allowlisted return-target KEY. Success/cancel URLs
 * are built on the server from configuration.
 */

/** Current billing state for the active workspace. Creates nothing. */
export async function getCommercialBillingState(): Promise<CommercialBillingDto> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  return readCommercialBillingDto(supabase, resolveBillingRuntime(), shop.id)
}

/**
 * Creates (or safely reuses) the single Founder Pilot Checkout for the active
 * workspace. Owner only. Replays return the existing open session; they never
 * create another per call.
 */
export async function requestFounderPilotCheckoutAction(
  returnTarget?: unknown
): Promise<CommercialBillingDto> {
  const user = await requireUser()
  const shop = await requireShop()
  if (returnTarget !== undefined && !isReturnTarget(returnTarget)) {
    return blockedDto("unknown", "billing_state_unavailable")
  }
  let service
  try {
    service = createServiceClient()
  } catch {
    return blockedDto("unknown", "billing_state_unavailable")
  }
  return requestFounderPilotCheckout(
    { service, runtime: resolveBillingRuntime() },
    { shopId: shop.id, actorId: user.id, returnTarget }
  )
}

/**
 * Opens the Stripe Customer Portal (test mode) for the active workspace's bound platform
 * customer. OWNER ONLY: the database re-verifies a live owner of this exact shop, so a
 * manager, staff member, revoked operator, other-workspace owner or anonymous caller gets
 * `owner_required`. The only client input is an allowlisted return-target KEY. The returned
 * URL is a short-lived bearer link: the caller should redirect to it and must not store it.
 */
export async function openCommercialBillingPortalAction(returnTarget?: unknown): Promise<PortalResult> {
  const user = await requireUser()
  const shop = await requireShop()
  if (returnTarget !== undefined && !isReturnTarget(returnTarget)) {
    return { ok: false, reason: "billing_state_unavailable" }
  }
  let service
  try {
    service = createServiceClient()
  } catch {
    return { ok: false, reason: "billing_state_unavailable" }
  }
  return requestCommercialBillingPortal(
    { service, runtime: resolvePortalRuntime() },
    { shopId: shop.id, actorId: user.id, returnTarget }
  )
}
