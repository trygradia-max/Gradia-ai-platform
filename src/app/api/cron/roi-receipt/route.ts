/**
 * Weekly ROI receipt push (FOCUS spec NOW-3).
 *
 * Runs weekly (see vercel.json). Each invocation:
 *   1. Loads every active (paying) shop.
 *   2. Computes its receipt for the trailing 7 days (lib/data/roi-receipt).
 *   3. Texts the owner a we/us digest of the week's value — but only when the
 *      shop's number can actually send (A2P-cleared Gradia number, or a
 *      BYO number the owner attested is registered). Otherwise it skips and
 *      logs; the always-visible Home receipt still carries the value.
 *
 * Empty weeks are skipped — we never text "you did nothing." This is an
 * owner-directed status message, not a customer outbound, so it doesn't go
 * through the HITL approval queue or burn the shop's message credits; it does
 * still respect the carrier A2P gate, which is a property of the sending
 * number regardless of who receives it.
 *
 * Vercel cron auth: `Authorization: Bearer <CRON_SECRET>`. Fails closed.
 */

import { composeReceiptSms, computeRoiReceipt } from "@/lib/data/roi-receipt"
import { forShop } from "@/lib/supabase/for-shop"
import { createServiceClient } from "@/lib/supabase/service"
import { smsGateForShop } from "@/lib/telephony-provider"
import { resolveTwilioCredentials, sendOutboundSms } from "@/lib/twilio"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const DAY_MS = 24 * 60 * 60 * 1000

/** Just the shop fields the push needs — keeps the SELECT tight. */
type PushShop = Pick<
  ShopRow,
  | "id"
  | "name"
  | "phone"
  | "twilio_phone_number"
  | "gradia_number_e164"
  | "a2p_status"
  | "byo_sms_verified"
  | "twilio_account_sid_enc"
  | "twilio_auth_token_enc"
  | "twilio_subaccount_sid"
  | "twilio_subaccount_token_enc"
>

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/roi-receipt] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return unauthorized()
  }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("shops")
    .select(
      "id, name, phone, twilio_phone_number, gradia_number_e164, a2p_status, byo_sms_verified, twilio_account_sid_enc, twilio_auth_token_enc, twilio_subaccount_sid, twilio_subaccount_token_enc"
    )
    .eq("plan", "active")

  if (error) {
    console.error("[cron/roi-receipt] shops query failed:", error)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const shops = (data as PushShop[] | null) ?? []
  const end = new Date()
  const start = new Date(end.getTime() - 7 * DAY_MS)

  let sent = 0
  let skippedEmpty = 0
  let skippedUnreachable = 0
  let failed = 0

  for (const shop of shops) {
    try {
      const receipt = await computeRoiReceipt(supabase, shop.id, start, end)

      // Persist the snapshot first — the Found Money Ledger keeps every week,
      // including empty ones, so the cumulative history has no gaps. Upsert on
      // the period so a re-run updates rather than duplicates. Tenant scope via
      // forShop (P0-011 helper proof): shop_id is stamped by the facade from
      // the cron-loaded row, never spelled per call.
      const { error: metricsErr } = await forShop(supabase, shop.id).upsert(
        "shop_metrics",
        {
          period_start: receipt.periodStart,
          period_end: receipt.periodEnd,
          attributed_revenue_cents: receipt.moneyInPlayCents,
          recovered_leads_count: receipt.recoveredLeadsCount,
          leads_count: receipt.leadsCaught,
          messages_count: receipt.messagesSent,
          bookings_count: receipt.bookingsMade,
        },
        { onConflict: "shop_id,period_start,period_end" }
      )
      if (metricsErr) {
        console.error("[cron/roi-receipt] metrics upsert failed for", shop.id, metricsErr)
      }

      const body = composeReceiptSms(shop.name, receipt)
      if (!body) {
        skippedEmpty += 1
        continue
      }

      // Need a sending number, an owner number to reach, and a clear A2P gate.
      const from = shop.twilio_phone_number
      const to = shop.phone
      if (!from || !to) {
        skippedUnreachable += 1
        continue
      }
      const gate = smsGateForShop(shop, from)
      if (!gate.allowed) {
        skippedUnreachable += 1
        continue
      }

      await sendOutboundSms({
        from,
        to,
        body,
        creds: resolveTwilioCredentials(shop),
      })
      sent += 1
    } catch (err) {
      console.error("[cron/roi-receipt] push failed for", shop.id, err)
      failed += 1
    }
  }

  return Response.json({
    ok: true,
    considered: shops.length,
    sent,
    skippedEmpty,
    skippedUnreachable,
    failed,
  })
}
