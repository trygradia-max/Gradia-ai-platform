/**
 * Signed PLATFORM commercial billing webhook (Commercial Billing PR E1, sandbox only).
 *
 * This is NOT the Stripe Connect webhook (`/api/stripe/webhook`). It has its own URL and
 * its own signing secret (GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET), refuses Connect
 * envelopes and live-mode objects, and is disabled (503) unless the sandbox
 * configuration is complete. The raw request body is read as text and verified before it
 * is parsed (Next.js Route Handler webhook pattern: `request.text()`).
 *
 * All decisions live in `handleCommercialWebhook`; this file only adapts HTTP.
 */

import { handleCommercialWebhook } from "@/lib/commercial-webhook-service"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function POST(request: Request) {
  const rawBody = await request.text()
  const result = await handleCommercialWebhook(
    { getService: () => createServiceClient() },
    { rawBody, signatureHeader: request.headers.get("stripe-signature") }
  )
  return Response.json(result.body, { status: result.status })
}
