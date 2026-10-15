import Link from "next/link"
import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { Pagination } from "@/components/gradia/pagination"
import { ReviewCard } from "@/components/gradia/review-card"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { StatusPill } from "@/components/ui/status-pill"
import { delegatedApprovalsSchema } from "@/lib/delegated-approvals"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { DelegatedApproveButton } from "./approve-button"

export const dynamic = "force-dynamic"
const channels = { send_sms: "Text message", send_email: "Email" } as const

/** Delegated message approval. Address selectors are never authorization; the
 *  list and the approval each recheck live membership and the grant in SQL. */
export default async function DelegatedApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; page?: string }>
}) {
  await requireUser()
  const db = await createClient(), params = await searchParams
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const allowed = ((workspaces.data ?? []) as TeamWorkspace[]).filter(
    (w) => w.role === "manager" && w.capabilities.includes("crm.read") && w.capabilities.includes("approvals.messages")
  )
  const workspace = params.shop ? allowed.find((w) => w.id === params.shop) : allowed[0]
  if (!workspace)
    return (
      <TeamChrome className="space-y-4">
        <SectionHeader
          level={1}
          eyebrow="Delegated review"
          title="Message approvals"
          subhead="Message approval for this shop has not been delegated to your account."
        />
        <Link href="/team" className="inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline">
          Back to your workspaces
        </Link>
      </TeamChrome>
    )
  const base = `/team/approvals?shop=${workspace.id}`
  const rawPage = Number(params.page ?? "1")
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage < 5000 ? rawPage : 1
  const result = await db.rpc("list_delegated_message_approvals", { p_shop: workspace.id, p_offset: (page - 1) * 20 })
  const queue = result.error ? null : delegatedApprovalsSchema.safeParse(result.data)
  return (
    <TeamChrome className="space-y-6">
      <Link href={`/team?shop=${workspace.id}`} className="inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline">
        Your workspaces
      </Link>
      <SectionHeader
        level={1}
        eyebrow="Delegated review"
        title={`${workspace.name} · Messages awaiting approval`}
        subhead="Approving sends the message exactly as shown if consent, opt-out status and quiet hours allow it. Rejecting sends nothing. You cannot edit here."
      />
      {!queue?.success ? (
        <ErrorState compact title="Messages could not be loaded. Nothing is assumed to be clear; refresh to try again." />
      ) : queue.data.items.length === 0 ? (
        <EmptyState title="No messages are waiting on this page." />
      ) : (
        <ol className="space-y-4">
          {queue.data.items.slice(0, 20).map((item) => (
            <li key={item.action_id}>
              <ReviewCard
                eyebrow={channels[item.action_type]}
                title={`To ${item.customer_name ?? "an unlinked recipient"}`}
                status={<StatusPill tone="warn">Pending</StatusPill>}
                evidence={
                  <>
                    <p>
                      Recipient: {item.destination ?? "missing"} · Queued {item.created_at} ·{" "}
                      {item.purpose === "service" ? "Owner-reviewed service reply" : "Marketing rules apply"}
                    </p>
                    {item.subject ? <p>Subject: {item.subject}</p> : null}
                    <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-foreground ring-1 ring-border">
                      {item.body ?? "Message content is missing."}
                    </p>
                    {item.reason ? <p>Why it was drafted: {item.reason}</p> : null}
                  </>
                }
                actions={
                  <DelegatedApproveButton
                    shopId={workspace.id}
                    actionId={item.action_id}
                    reviewHash={item.review_hash}
                  />
                }
              />
            </li>
          ))}
        </ol>
      )}
      <Pagination
        label="Message approval pages"
        previous={page > 1 ? { href: `${base}&page=${page - 1}` } : null}
        next={queue?.success && queue.data.items.length > 20 ? { href: `${base}&page=${page + 1}` } : null}
      />
    </TeamChrome>
  )
}
