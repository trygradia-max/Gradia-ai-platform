/**
 * Held A2P status reconciler route (src/lib/a2p-reconciler.ts).
 *
 * NOT a scheduled cron: it isn't in vercel.json or the cron registry, and
 * nothing calls it. It does nothing unless A2P_RECONCILER_ENABLED=true. The
 * release lane decides whether and how often to call it; see the freshness
 * relationship in a2p-reconciler.ts.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`, like the crons. Fails closed.
 */
import { a2pReconcilerEnabled, reconcileA2pRegistrations } from "@/lib/a2p-reconciler"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[internal/a2p-reconcile] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) return unauthorized()
  // Held: off unless the release lane turns it on. Off reads nothing.
  if (!a2pReconcilerEnabled()) return Response.json({ ok: true, enabled: false })

  let origin: string
  try {
    origin = new URL(process.env.GRADIA_DASHBOARD_URL?.trim() ?? "").origin
  } catch {
    return Response.json({ ok: false, error: "GRADIA_DASHBOARD_URL isn't configured" }, { status: 500 })
  }
  try {
    const summary = await reconcileA2pRegistrations({ supabase: createServiceClient(), origin })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[internal/a2p-reconcile] run failed:", message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
