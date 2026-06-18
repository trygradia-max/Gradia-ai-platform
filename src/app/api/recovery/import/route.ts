/**
 * Customer Recovery — upload + ingest (P8 / NEXT-3, GRADIA_CUSTOMER_RECOVERY_SPEC
 * §1). Accepts an .mbox / contacts CSV / vCard, parses + pre-filters it into
 * staged units, stores raw bodies in the private bucket, and returns the
 * pre-run credit estimate the owner approves before any LLM spend (POST to
 * /api/recovery/import/[jobId]/extract to actually run it).
 *
 * Gated behind FEATURES.customerRecovery (404 while off). Fail-closed on plan /
 * credits, same as every other metered surface.
 */

import { checkFeatureAccess, loadShopCreditFields } from "@/lib/credits"
import { FEATURES } from "@/lib/features"
import { getPricing } from "@/lib/pricing"
import { ingestImport } from "@/lib/recovery/ingest"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import type { ImportSourceType } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Parsing + staging a large mbox can run long; extraction is a separate call.
export const maxDuration = 300

// Alpha cap. Multi-GB Takeout exports need streamed chunked upload — a follow-up.
const MAX_BYTES = 60 * 1024 * 1024
const SOURCE_TYPES: ImportSourceType[] = ["mbox", "contacts_csv", "vcard"]

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export async function POST(request: Request) {
  if (!FEATURES.customerRecovery) {
    return new Response("Not found", { status: 404 })
  }

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

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return json({ ok: false, error: "Couldn't read the upload." }, 400)
  }

  const sourceType = String(formData.get("source_type") ?? "") as ImportSourceType
  if (!SOURCE_TYPES.includes(sourceType)) {
    return json({ ok: false, error: "Unsupported import type." }, 400)
  }
  const file = formData.get("file")
  if (!(file instanceof File)) return json({ ok: false, error: "No file attached." }, 400)
  if (file.size === 0) return json({ ok: false, error: "That file is empty." }, 400)
  if (file.size > MAX_BYTES) {
    return json({ ok: false, error: "File too large — keep it under 60 MB for now." }, 400)
  }

  const fileContent = await file.text()

  // Owner addresses anchor mbox owner-participation: the login email, the
  // connected mailbox, plus any explicitly provided.
  const { data: shopRow } = await supabase
    .from("shops")
    .select("aurinko_account_email")
    .eq("id", shop.id)
    .maybeSingle()
  const ownerEmails = [
    user.email ?? "",
    (shopRow as { aurinko_account_email: string | null } | null)?.aurinko_account_email ?? "",
    ...String(formData.get("owner_emails") ?? "")
      .split(",")
      .map((s) => s.trim()),
  ].filter(Boolean)

  const pricing = await getPricing(supabase)
  const service = createServiceClient()

  try {
    const result = await ingestImport(service, shop.id, {
      sourceType,
      fileContent,
      ownerEmails,
      pricing,
    })
    return json({ ok: true, ...result })
  } catch (err) {
    console.error("[recovery/import] ingest failed:", err)
    return json({ ok: false, error: "Couldn't process that import — try again." }, 500)
  }
}
