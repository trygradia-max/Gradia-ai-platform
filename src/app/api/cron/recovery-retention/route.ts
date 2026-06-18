/**
 * Customer Recovery retention cron (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §1.2). Runs daily (see vercel.json):
 *   1. Mark abandoned in-progress imports failed.
 *   2. Purge raw thread/contact bodies for failed/stale/past-retention jobs,
 *      and null out the import_messages body_ref so the record shows it's gone.
 *
 * runExtraction already purges bodies on completion — this is the safety net.
 *
 * Vercel cron auth: `Authorization: Bearer <CRON_SECRET>`. Fails closed.
 */

import { planRetention, type RetentionJob } from "@/lib/recovery/retention"
import { deleteJobBodies } from "@/lib/recovery/storage"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const DAY_MS = 24 * 60 * 60 * 1000

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/recovery-retention] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return unauthorized()
  }

  const supabase = createServiceClient()
  const now = Date.now()
  // Only pull jobs that could need action: in-progress, failed, or older than a
  // generous retention horizon. Keeps the scan small at scale.
  const horizonIso = new Date(now - 31 * DAY_MS).toISOString()

  const { data, error } = await supabase
    .from("import_jobs")
    .select("id, shop_id, status, created_at, updated_at")
    .or(
      `status.eq.failed,status.eq.estimating,status.eq.extracting,created_at.lt.${horizonIso}`
    )
  if (error) {
    console.error("[cron/recovery-retention] query failed:", error)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const rows =
    (data as (RetentionJob & { shop_id: string })[] | null) ?? []
  const shopById = new Map(rows.map((r) => [r.id, r.shop_id]))
  const plan = planRetention(rows, now)

  // 1. Mark abandoned in-progress jobs failed.
  for (const id of plan.toFail) {
    await supabase
      .from("import_jobs")
      .update({
        status: "failed",
        error: "Timed out — the import was abandoned mid-run.",
        updated_at: new Date(now).toISOString(),
      })
      .eq("id", id)
  }

  // 2. Purge raw bodies + clear body_ref on the staged rows.
  let purged = 0
  for (const id of plan.toPurge) {
    const shopId = shopById.get(id)
    if (!shopId) continue
    await deleteJobBodies(supabase, shopId, id)
    await supabase
      .from("import_messages")
      .update({ body_ref: null })
      .eq("import_job_id", id)
      .not("body_ref", "is", null)
    purged += 1
  }

  return Response.json({
    ok: true,
    considered: rows.length,
    failed: plan.toFail.length,
    purged,
  })
}
