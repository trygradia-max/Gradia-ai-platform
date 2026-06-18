import { ActivityEvent } from "@/components/gradia/activity-event"
import { ApprovalsList } from "@/components/gradia/approvals-list"
import {
  listOpenApprovalsForCurrentShop,
  listRecentAgentActivity,
} from "@/lib/data/pending-actions"

export const dynamic = "force-dynamic"

export default async function ApprovalsPage() {
  const items = await listOpenApprovalsForCurrentShop()
  const activity = await listRecentAgentActivity()
  const editCount = items.filter(
    (i) => i.status === "edit_requested"
  ).length
  const pendingCount = items.length - editCount

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Approvals</p>
        <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
          {items.length === 0 ? (
            <>
              <span className="italic">All</span> clear.
            </>
          ) : (
            <>
              <span className="italic">Waiting</span> on us.
            </>
          )}
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {items.length === 0
            ? "Nothing needs your eyes right now — we'll surface anything that does the moment it lands."
            : `A quick yes or no before anything leaves the shop — ${pendingCount} pending${
                editCount > 0 ? ` · ${editCount} need a tweak` : ""
              }.`}
        </p>
      </header>

      <ApprovalsList items={items} />

      {activity.length > 0 ? (
        <section className="space-y-3">
          <p className="label-eyebrow text-muted-foreground/70">Done by us</p>
          <div className="space-y-2">
            {activity.map((a) => (
              <ActivityEvent key={a.id} item={a} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
