import Link from "next/link"
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
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Message approvals</h1>
        <p>Message approval for this shop has not been delegated to your account.</p>
        <Link href="/team" className="underline">Back to your workspaces</Link>
      </main>
    )
  const base = `/team/approvals?shop=${workspace.id}`
  const rawPage = Number(params.page ?? "1")
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage < 5000 ? rawPage : 1
  const result = await db.rpc("list_delegated_message_approvals", { p_shop: workspace.id, p_offset: (page - 1) * 20 })
  const queue = result.error ? null : delegatedApprovalsSchema.safeParse(result.data)
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <Link href={`/team?shop=${workspace.id}`} className="underline">Your workspaces</Link>
      <h1 className="text-2xl font-semibold">{workspace.name} · Messages awaiting approval</h1>
      <p>
        You can approve queued texts and emails for this shop. Approving sends the message exactly as shown, if the
        customer’s consent, opt-out status and quiet hours allow it. You cannot edit or reject here; bookings, quotes
        and record changes stay with the shop owner.
      </p>
      {!queue?.success ? (
        <p role="alert">Messages could not be loaded. Nothing is assumed to be clear; refresh to try again.</p>
      ) : queue.data.items.length === 0 ? (
        <p>No messages are waiting on this page.</p>
      ) : (
        <ol className="space-y-4">
          {queue.data.items.slice(0, 20).map((item) => (
            <li key={item.action_id} className="space-y-2 rounded border p-3">
              <p className="font-medium">
                {channels[item.action_type]} to {item.customer_name ?? "an unlinked recipient"}
              </p>
              <p>
                Recipient: {item.destination ?? "missing"} · Queued {item.created_at} ·{" "}
                {item.purpose === "service" ? "Owner-reviewed service reply" : "Marketing rules apply"}
              </p>
              {item.subject ? <p>Subject: {item.subject}</p> : null}
              <p className="whitespace-pre-wrap break-words rounded border p-2">{item.body ?? "Message content is missing."}</p>
              {item.reason ? <p>Why it was drafted: {item.reason}</p> : null}
              <DelegatedApproveButton shopId={workspace.id} actionId={item.action_id} reviewHash={item.review_hash} />
            </li>
          ))}
        </ol>
      )}
      <nav aria-label="Message approval pages" className="flex gap-4">
        {page > 1 ? <Link href={`${base}&page=${page - 1}`} className="underline">Previous</Link> : null}
        {queue?.success && queue.data.items.length > 20 ? <Link href={`${base}&page=${page + 1}`} className="underline">Next</Link> : null}
      </nav>
    </main>
  )
}
