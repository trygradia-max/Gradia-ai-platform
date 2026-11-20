import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordCallCopilotEvent, type CallCopilotIngressResult } from "./ingress"
import { type CallCopilotEvent, type CallCopilotProvider } from "./events"

/**
 * The Gradia-controlled provider seam for human-first inbound Call Copilot
 * ingress (PR D). A provider module implements `CallCopilotProviderSeam`;
 * nothing vendor-shaped crosses it. This PR ships the contract and the
 * orchestration only: NO provider implementation and NO route exist, because
 * no verified provider contract yet produces disclosure or consent evidence
 * (see docs/architecture/CALL_COPILOT_INGRESS.md).
 *
 * A seam implementation MUST, before it returns `accepted: true`:
 *   1. verify the provider's signature over the raw request;
 *   2. resolve the shop from Gradia's own number/route binding, never from a
 *      payload field;
 *   3. confirm the call traversed a Gradia-controlled path (`routeKind`);
 *   4. translate the callback into content-free `CallCopilotEvent`s with a
 *      per-call `sequence`.
 * A callback that fails any step is `accepted: false` and writes nothing.
 */
export type CallCopilotCallback =
  | { accepted: true; shopId: string; events: unknown[] }
  | { accepted: false; reason: "signature_invalid" | "unbound_number" | "uncontrolled_route" | "malformed" }

export interface CallCopilotProviderSeam {
  readonly provider: CallCopilotProvider
  acceptCallback(request: Request): Promise<CallCopilotCallback>
}

export type CallCopilotCallbackOutcome =
  | { status: "rejected"; reason: Extract<CallCopilotCallback, { accepted: false }>["reason"] }
  | { status: "processed"; results: CallCopilotIngressResult[] }

/**
 * Run one verified callback through the ledger. Events are applied in the
 * order given; each is independently idempotent, so a provider retry of the
 * whole callback is safe. A database failure throws (the route should 5xx so
 * the provider retries). Nothing is written for a rejected callback.
 */
export async function handleCallCopilotCallback(
  db: SupabaseClient,
  seam: CallCopilotProviderSeam,
  request: Request,
): Promise<CallCopilotCallbackOutcome> {
  const accepted = await seam.acceptCallback(request)
  if (!accepted.accepted) return { status: "rejected", reason: accepted.reason }
  if (!z.string().uuid().safeParse(accepted.shopId).success || !Array.isArray(accepted.events)) {
    return { status: "rejected", reason: "malformed" }
  }
  const results: CallCopilotIngressResult[] = []
  for (const event of accepted.events as CallCopilotEvent[]) {
    results.push(await recordCallCopilotEvent(db, { shopId: accepted.shopId, provider: seam.provider, event }))
  }
  return { status: "processed", results }
}
