import Link from "next/link"
import { z } from "zod"
import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { Pagination } from "@/components/gradia/pagination"
import { ReviewCard } from "@/components/gradia/review-card"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { DeliveryReconciliationHistory } from "@/components/gradia/delivery-reconciliation-history"
import { StatusPill } from "@/components/ui/status-pill"
import { deliveryHoldsSchema, deliveryOutcomes } from "@/lib/delivery-reconciliation"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"

export const dynamic = "force-dynamic"
const channels: Record<string, string> = { send_sms: "Text message", send_email: "Email" }
const backLink =
  "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

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
      <TeamChrome className="space-y-4">
        <SectionHeader
          level={1}
          eyebrow="Delivery evidence"
          title="Delivery reviews"
          subhead="Delivery review for this shop has not been delegated to your account."
        />
        <Link href="/team" className={backLink}>Back to your workspaces</Link>
      </TeamChrome>
    )
  const base = `/team/delivery-reviews?shop=${workspace.id}`
  const actionId = z.string().uuid().safeParse(params.action)
  if (params.action !== undefined) {
    return (
      <TeamChrome className="space-y-6">
        <Link href={base} className={backLink}>Held messages</Link>
        <SectionHeader
          level={1}
          eyebrow="Delivery evidence"
          title={`${workspace.name} · Delivery review`}
          subhead="A review records what you checked. It never resends, releases the message or clears the hold."
        />
        {actionId.success ? (
          <DeliveryReconciliationHistory
            db={db}
            shopId={workspace.id}
            actionId={actionId.data}
            page={params.reviewOffset}
            pageHref={(offset) => `${base}&action=${actionId.data}&reviewOffset=${offset}`}
          />
        ) : (
          <ErrorState compact title="This delivery review link is not valid. Return to the held messages." />
        )}
      </TeamChrome>
    )
  }
  const rawPage = Number(params.page ?? "1")
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage < 5000 ? rawPage : 1
  const result = await db.rpc("list_delivery_holds", { p_shop: workspace.id, p_offset: (page - 1) * 20 })
  const holds = result.error ? null : deliveryHoldsSchema.safeParse(result.data)
  return (
    <TeamChrome className="space-y-6">
      <Link href={`/team?shop=${workspace.id}`} className={backLink}>Your workspaces</Link>
      <SectionHeader
        level={1}
        eyebrow="Delivery evidence"
        title={`${workspace.name} · Held messages`}
        subhead="These messages were claimed for sending and their outcome is not confirmed. A review records what you checked. It never resends, releases the message or clears the hold."
      />
      {!holds?.success ? (
        <ErrorState compact title="Held messages could not be loaded. Nothing is assumed to be clear; refresh to try again." />
      ) : holds.data.items.length === 0 ? (
        <EmptyState title="No held messages on this page." />
      ) : (
        <ol className="space-y-3">
          {holds.data.items.slice(0, 20).map((hold) => (
            <li key={hold.action_id}>
              <ReviewCard
                eyebrow={(hold.action_type && channels[hold.action_type]) ?? "Message"}
                title={hold.customer_name ?? "Customer record unavailable"}
                status={
                  <StatusPill tone={hold.latest_outcome ? "good" : "warn"}>
                    {hold.latest_outcome ? "Reviewed" : "Not reviewed yet"}
                  </StatusPill>
                }
                evidence={
                  <>
                    <p>
                      Claimed {hold.claimed_at} · {hold.completed_at ? `provider accepted ${hold.completed_at}` : "no provider response recorded"}
                    </p>
                    {hold.body ? (
                      <p className="whitespace-pre-wrap break-words text-foreground">{hold.body}</p>
                    ) : (
                      <p>Message content is no longer available.</p>
                    )}
                    {hold.latest_outcome ? (
                      <p>
                        Latest review ({hold.review_revision}): {deliveryOutcomes[hold.latest_outcome]}
                      </p>
                    ) : null}
                  </>
                }
                actions={
                  <Link href={`${base}&action=${hold.action_id}`} className={backLink}>
                    Review delivery
                  </Link>
                }
              />
            </li>
          ))}
        </ol>
      )}
      <Pagination
        label="Held message pages"
        previous={page > 1 ? { href: `${base}&page=${page - 1}` } : null}
        next={holds?.success && holds.data.items.length > 20 ? { href: `${base}&page=${page + 1}` } : null}
      />
    </TeamChrome>
  )
}
