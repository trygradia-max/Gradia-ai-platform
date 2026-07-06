import { ActivityEvent } from "@/components/gradia/activity-event"
import { ApprovalsList } from "@/components/gradia/approvals-list"
import {
  listOpenApprovalsForCurrentShop,
  listRecentAgentActivity,
} from "@/lib/data/pending-actions"
import { STRINGS } from "@/lib/strings"

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
        <p className="label-eyebrow text-muted-foreground/70">
          {STRINGS.pages.approvals.eyebrow}
        </p>
        <h1 className="font-display text-2xl text-foreground">
          {items.length === 0
            ? `${STRINGS.pages.approvals.titleAllClear}.`
            : `${STRINGS.pages.approvals.titleWaiting}.`}
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {items.length === 0
            ? STRINGS.pages.approvals.subtitleEmpty
            : STRINGS.pages.approvals.subtitleWaiting(pendingCount, editCount)}
        </p>
      </header>

      <ApprovalsList items={items} />

      {activity.length > 0 ? (
        <section className="space-y-3">
          <p className="label-eyebrow text-muted-foreground/70">
            {STRINGS.chrome.handledByReceptionist}
          </p>
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
