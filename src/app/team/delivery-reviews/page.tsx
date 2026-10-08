import Link from "next/link"
import { z } from "zod"
import { DeliveryReconciliationHistory } from "@/components/gradia/delivery-reconciliation-history"
import { deliveryHoldsSchema, deliveryOutcomes } from "@/lib/delivery-reconciliation"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"

export const dynamic = "force-dynamic"
const channels: Record<string, string> = { send_sms: "Text message", send_email: "Email" }

/** Delegated delivery review. Selectors in the address are never authorization;
 *  every read and write rechecks live membership and the explicit grant in SQL. */
export default async function DeliveryReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; action?: string; page?: string; reviewOffset?: string }>
}) {
  await requireUser()
  const db = await createClient(), params = await searchParams
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const allowed = ((workspaces.data ?? []) as TeamWorkspace[]).filter(
    (w) =>
      w.role === "owner" ||
      (w.role === "manager" && w.capabilities.includes("crm.read") && w.capabilities.includes("delivery.reconcile"))
  )
  const workspace = params.shop ? allowed.find((w) => w.id === params.shop) : allowed[0]
  if (!workspace)
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Delivery reviews</h1>
        <p>Delivery review for this shop has not been delegated to your account.</p>
        <Link href="/team" className="underline">Back to your workspaces</Link>
      </main>
    )
  const base = `/team/delivery-reviews?shop=${workspace.id}`
  const actionId = z.string().uuid().safeParse(params.action)
  if (params.action !== undefined) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <Link href={base} className="underline">Held messages</Link>
        <h1 className="text-2xl font-semibold">{workspace.name} · Delivery review</h1>
        {actionId.success ? (
          <DeliveryReconciliationHistory
            db={db}
            shopId={workspace.id}
            actionId={actionId.data}
            page={params.reviewOffset}
            pageHref={(offset) => `${base}&action=${actionId.data}&reviewOffset=${offset}`}
          />
        ) : (
          <p role="alert">This delivery review link is not valid. Return to the held messages.</p>
        )}
      </main>
    )
  }
  const rawPage = Number(params.page ?? "1")
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage < 5000 ? rawPage : 1
  const result = await db.rpc("list_delivery_holds", { p_shop: workspace.id, p_offset: (page - 1) * 20 })
  const holds = result.error ? null : deliveryHoldsSchema.safeParse(result.data)
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <Link href={`/team?shop=${workspace.id}`} className="underline">Your workspaces</Link>
      <h1 className="text-2xl font-semibold">{workspace.name} · Held messages</h1>
      <p>
        These messages were claimed for sending and their outcome is not confirmed. A review records what you
        checked. It never resends, releases the message or clears the hold.
      </p>
      {!holds?.success ? (
        <p role="alert">Held messages could not be loaded. Nothing is assumed to be clear; refresh to try again.</p>
      ) : holds.data.items.length === 0 ? (
        <p>No held messages on this page.</p>
      ) : (
        <ol className="space-y-3">
          {holds.data.items.slice(0, 20).map((hold) => (
            <li key={hold.action_id} className="space-y-1 rounded border p-3">
              <p className="font-medium">
                {(hold.action_type && channels[hold.action_type]) ?? "Message"} · {hold.customer_name ?? "Customer record unavailable"}
              </p>
              <p>
                Claimed {hold.claimed_at} · {hold.completed_at ? `provider accepted ${hold.completed_at}` : "no provider response recorded"}
              </p>
              {hold.body ? <p className="whitespace-pre-wrap break-words">{hold.body}</p> : <p>Message content is no longer available.</p>}
              <p>
                {hold.latest_outcome
                  ? `Latest review (${hold.review_revision}): ${deliveryOutcomes[hold.latest_outcome]}`
                  : "Not reviewed yet"}
              </p>
              <Link href={`${base}&action=${hold.action_id}`} className="underline">Review delivery</Link>
            </li>
          ))}
        </ol>
      )}
      <nav aria-label="Held message pages" className="flex gap-4">
        {page > 1 ? <Link href={`${base}&page=${page - 1}`} className="underline">Previous</Link> : null}
        {holds?.success && holds.data.items.length > 20 ? <Link href={`${base}&page=${page + 1}`} className="underline">Next</Link> : null}
      </nav>
    </main>
  )
}
