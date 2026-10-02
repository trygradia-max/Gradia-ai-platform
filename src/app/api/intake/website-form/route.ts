/**
 * POST /api/intake/website-form
 *
 * The shop is the signed-in owner's active shop. This app has no
 * website-form token or public form key. A quote public_token identifies
 * one quote, not a lead form. A shop_id in the body is not the tenant:
 * a missing shop, or a shop_id that does not match the session, is refused.
 * submission_id is the caller-supplied provider event id. The handler
 * calls record_lead_intake once.
 */

import { acceptWebsiteFormIntake } from "@/lib/lead-intake"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return json({ ok: false, error: "Sign-in expired — refresh." }, 401)

  const shop = await getOptionalShop()
  if (!shop) return json({ ok: false, error: "Set up your shop first." }, 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: "Check the submission and try again." }, 400)
  }

  // Service role is required for record_lead_intake. The shop id stays the
  // session shop passed below; the body cannot replace it.
  const db = createServiceClient()
  const receivedAt = new Date().toISOString()
  try {
    const accepted = await acceptWebsiteFormIntake(db, shop.id, body, receivedAt)
    if (!accepted.ok) return json({ ok: false, error: accepted.error }, accepted.status)
    return json({
      ok: true,
      status: accepted.result.status,
      envelope_id: accepted.result.envelopeId,
      workflow_id: accepted.result.workflowId,
    })
  } catch (err) {
    console.error(
      "[website-form] intake failed",
      err instanceof Error ? err.message : "unknown",
    )
    return json({ ok: false, error: "Couldn't save that submission." }, 500)
  }
}
