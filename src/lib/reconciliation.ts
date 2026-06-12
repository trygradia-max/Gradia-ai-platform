/**
 * Nightly vendor reconciliation (TELEPHONY_VOICE_BUILDER_SPEC §1.4).
 *
 * The usage_events ledger is what we BILL from; the vendor's usage API is
 * what we PAY from. If they drift, either metering has a gap (we're eating
 * costs) or it's double-counting (we're overcharging) — both are alert-now
 * problems. Per the metering conventions, a vendor integration isn't done
 * until its reconciliation job exists.
 *
 * Twilio: ledger wholesale totals per subaccount vs Usage Records
 * month-to-date (calendar-aligned on both sides so number-rental timing
 * doesn't read as drift). Alert at >2%, with a $1 noise floor so a shop
 * with three text messages doesn't page anyone over rounding.
 *
 * Vapi gets its own pass when the voice builder lands — voice_minute rows
 * carry bundled costs that span vendors, so they're excluded here.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { tryDecryptSecret } from "@/lib/crypto"
import { fetchMonthToDateUsageCents } from "@/lib/twilio"
import type { ShopRow } from "@/lib/types/database"

/** Kinds whose wholesale_cost is paid to Twilio. */
const TWILIO_LEDGER_KINDS = ["sms_segment", "number_monthly"] as const

/** Don't alert below this combined spend — rounding noise, not drift. */
const NOISE_FLOOR_CENTS = 100

export const DRIFT_ALERT_THRESHOLD_PCT = 2

export type DriftResult = {
  driftPct: number
  alert: boolean
}

/**
 * Relative drift between what we metered and what the vendor measured,
 * against the larger of the two (symmetric: catches both under-metering
 * and over-metering). Pure — the 2% threshold and noise floor live here
 * so the tests can pin them.
 */
export function computeDrift(
  ledgerCents: number,
  vendorCents: number
): DriftResult {
  const larger = Math.max(ledgerCents, vendorCents)
  if (larger <= 0) return { driftPct: 0, alert: false }
  const driftPct = (Math.abs(ledgerCents - vendorCents) / larger) * 100
  const aboveFloor = ledgerCents >= NOISE_FLOOR_CENTS || vendorCents >= NOISE_FLOOR_CENTS
  return {
    driftPct,
    alert: aboveFloor && driftPct > DRIFT_ALERT_THRESHOLD_PCT,
  }
}

export type ShopDrift = {
  shopId: string
  shopName: string
  ledgerCents: number
  vendorCents: number
  driftPct: number
}

export type ReconciliationSummary = {
  checked: number
  skipped: number
  drifting: ShopDrift[]
}

function monthStartUtcIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Ops alert: always in the logs; mirrored to Slack when a webhook is set.
 * Deliberately NOT gated by FEATURES.slackApprovals — that flag governs the
 * HITL approval surface, and this is an operator alert. */
async function alertDrift(drifting: ShopDrift[]): Promise<void> {
  const lines = drifting.map(
    (d) =>
      `${d.shopName} (${d.shopId}): ledger ${(d.ledgerCents / 100).toFixed(2)} vs Twilio ${(d.vendorCents / 100).toFixed(2)} USD — ${d.driftPct.toFixed(1)}% drift`
  )
  console.error(`[reconcile] DRIFT >${DRIFT_ALERT_THRESHOLD_PCT}%:\n${lines.join("\n")}`)

  const webhook = process.env.SLACK_WEBHOOK_URL?.trim()
  if (!webhook) return
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:warning: Telephony reconciliation drift (>${DRIFT_ALERT_THRESHOLD_PCT}%) — month to date\n${lines.join("\n")}`,
      }),
    })
  } catch (err) {
    console.error("[reconcile] Slack alert failed:", err)
  }
}

/**
 * Sweeps every shop with a Twilio subaccount: month-to-date ledger
 * wholesale vs the subaccount's Usage Records, alerting on the set that
 * drifted. A shop whose vendor fetch fails is counted as skipped and
 * logged — a broken fetch must not hide as "no drift".
 */
export async function reconcileTwilioUsage(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<ReconciliationSummary> {
  const { data, error } = await supabase
    .from("shops")
    .select("id, name, twilio_subaccount_sid, twilio_subaccount_token_enc")
    .not("twilio_subaccount_sid", "is", null)
  if (error) {
    console.error("[reconcile] shop query failed:", error)
    return { checked: 0, skipped: 0, drifting: [] }
  }

  const shops = (data ?? []) as Pick<
    ShopRow,
    "id" | "name" | "twilio_subaccount_sid" | "twilio_subaccount_token_enc"
  >[]
  const since = monthStartUtcIso(now)
  const summary: ReconciliationSummary = { checked: 0, skipped: 0, drifting: [] }

  for (const shop of shops) {
    const token = tryDecryptSecret(shop.twilio_subaccount_token_enc)
    if (!shop.twilio_subaccount_sid || !token) {
      summary.skipped++
      continue
    }

    const { data: rows, error: ledgerError } = await supabase
      .from("usage_events")
      .select("wholesale_cost")
      .eq("shop_id", shop.id)
      .in("kind", [...TWILIO_LEDGER_KINDS])
      .gte("created_at", since)
    if (ledgerError) {
      console.error(`[reconcile] ledger query failed for ${shop.id}:`, ledgerError)
      summary.skipped++
      continue
    }
    const ledgerCents = ((rows as { wholesale_cost: number | null }[] | null) ?? []).reduce(
      (sum, r) => sum + (r.wholesale_cost ?? 0),
      0
    )

    let vendorCents: number
    try {
      vendorCents = await fetchMonthToDateUsageCents({
        accountSid: shop.twilio_subaccount_sid,
        authToken: token,
      })
    } catch (err) {
      console.error(`[reconcile] Twilio usage fetch failed for ${shop.id}:`, err)
      summary.skipped++
      continue
    }

    summary.checked++
    const drift = computeDrift(ledgerCents, vendorCents)
    if (drift.alert) {
      summary.drifting.push({
        shopId: shop.id,
        shopName: shop.name,
        ledgerCents,
        vendorCents,
        driftPct: drift.driftPct,
      })
    }
  }

  if (summary.drifting.length > 0) await alertDrift(summary.drifting)
  return summary
}
