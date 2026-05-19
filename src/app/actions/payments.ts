"use server"

import { revalidatePath } from "next/cache"

import { requireShop, requireUser } from "@/lib/shop"
import { iteratePaidInvoices } from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export type BackfillResult =
  | { ok: true; processed: number; skippedNoAmount: number }
  | { ok: false; error: string }

/**
 * One-shot backfill of historical paid invoices from the shop's
 * connected Stripe account into our local payments mirror.
 *
 * Idempotent — uses the same (shop_id, stripe_invoice_id) unique
 * constraint as the webhook. Invoices that already mirrored just
 * upsert in place (no duplicates). Customers can't be linked to old
 * historical invoices that pre-dated Gradia (no originating
 * interaction to look through), so customer_id stays null for those
 * rows. Operator can merge later via /customers/[id] if needed.
 *
 * Long-running: at 100 invoices/page, ~1 second per page, a shop with
 * thousands of historical invoices may hit Vercel's serverless
 * timeout. Pilot caps don't matter here; revisit if it becomes a
 * real bottleneck.
 */
export async function backfillStripePayments(): Promise<BackfillResult> {
  await requireUser()
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null

  if (!shop?.stripe_account_id || !shop.stripe_charges_enabled) {
    return {
      ok: false,
      error: "Finish Stripe onboarding in /settings before syncing history.",
    }
  }

  let processed = 0
  let skippedNoAmount = 0

  try {
    for await (const inv of iteratePaidInvoices(shop.stripe_account_id)) {
      const amount = typeof inv.amount_paid === "number" ? inv.amount_paid : 0
      if (amount <= 0 || !inv.id) {
        skippedNoAmount += 1
        continue
      }

      const description =
        inv.description?.trim() ||
        inv.lines?.data?.[0]?.description?.trim() ||
        null
      const paidAtIso =
        typeof inv.status_transitions?.paid_at === "number"
          ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
          : new Date().toISOString()

      const { error: upsertErr } = await supabase
        .from("payments")
        .upsert(
          {
            shop_id: shop.id,
            customer_id: null,
            amount_cents: amount,
            currency: (inv.currency ?? "usd").toLowerCase(),
            description,
            stripe_account_id: shop.stripe_account_id,
            stripe_invoice_id: inv.id,
            stripe_invoice_number: inv.number ?? null,
            hosted_invoice_url: inv.hosted_invoice_url ?? null,
            paid_at: paidAtIso,
          },
          { onConflict: "shop_id,stripe_invoice_id", ignoreDuplicates: false }
        )

      if (upsertErr) {
        console.error("[backfill] upsert failed for invoice", inv.id, upsertErr)
        continue
      }
      processed += 1
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Stripe: ${err.message}`
          : "Backfill failed mid-run.",
    }
  }

  revalidatePath("/dashboard")
  revalidatePath("/settings")
  return { ok: true, processed, skippedNoAmount }
}
