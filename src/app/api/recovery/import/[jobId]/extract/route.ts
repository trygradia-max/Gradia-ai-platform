/**
 * Customer Recovery — confirm + extract (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §2). The owner has seen the estimate; this
 * spends credits to run the extraction worker over the staged units, meters
 * each call, and (once the whole job is done) returns deduped candidates for
 * the review queue. Chunked — call again while `done` is false to drain a
 * large import.
 *
 * Gated behind FEATURES.customerRecovery (404 while off). Fail-closed on plan /
 * credits via runExtraction's pre-check.
 */

import { checkFeatureAccess, loadShopCreditFields } from "@/lib/credits"
import { FEATURES } from "@/lib/features"
import { getPricing } from "@/lib/pricing"
import { runCsvVehicleCleanup } from "@/lib/recovery/csv-cleanup"
import { runExtraction } from "@/lib/recovery/run-extraction"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  if (!FEATURES.customerRecovery) {
    return new Response("Not found", { status: 404 })
  }
  const { jobId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return json({ ok: false, error: "Sign-in expired — refresh." }, 401)

  const shop = await getOptionalShop()
  if (!shop) return json({ ok: false, error: "Set up your shop first." }, 403)

  const creditFields = await loadShopCreditFields(supabase, shop.id)
  if (!creditFields) return json({ ok: false, error: "Set up your shop first." }, 403)
  const access = await checkFeatureAccess(supabase, creditFields)
  if (!access.ok) return json({ ok: false, error: access.reason }, access.status)

  const pricing = await getPricing(supabase)
  const service = createServiceClient()

  // C7 structured CSV: drain the metered Haiku vehicle cleanups first; once
  // none remain, fall through to runExtraction, which finds no un-extracted
  // rows and runs the shared finale (dedupe -> ready). Same chunking contract.
  const { data: jobRow } = await service
    .from("import_jobs")
    .select("source_type")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  if ((jobRow as { source_type: string } | null)?.source_type === "structured_csv") {
    const cleanup = await runCsvVehicleCleanup(service, creditFields, jobId, pricing)
    if (!cleanup.ok) {
      const status = /credit/i.test(cleanup.error) ? 402 : 400
      return json(cleanup, status)
    }
    if (cleanup.remaining > 0) {
      return json({
        ok: true,
        jobId,
        extracted: cleanup.cleaned,
        remaining: cleanup.remaining,
        done: false,
        candidates: [],
      })
    }
  }

  const result = await runExtraction(service, creditFields, jobId, pricing)
  if (!result.ok) {
    // Out-of-credits reads as 402; everything else (not found / wrong status) 400.
    const status = /credit/i.test(result.error) ? 402 : 400
    return json(result, status)
  }
  return json(result)
}
