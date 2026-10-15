import { ActivityEvent } from "@/components/gradia/activity-event"
import { ApprovalsList } from "@/components/gradia/approvals-list"
import { SectionHeader } from "@/components/gradia/section-header"
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
      <SectionHeader
        level={1}
        eyebrow={STRINGS.pages.approvals.eyebrow}
        title={
          items.length === 0
            ? `${STRINGS.pages.approvals.titleAllClear}.`
            : `${STRINGS.pages.approvals.titleWaiting}.`
        }
        subhead={
          items.length === 0
            ? STRINGS.pages.approvals.subtitleEmpty
            : STRINGS.pages.approvals.subtitleWaiting(pendingCount, editCount)
        }
      />

      <ApprovalsList items={items} />

      {activity.length > 0 ? (
        <section className="space-y-3">
          <SectionHeader
            eyebrow={STRINGS.chrome.handledByReceptionist}
            title="Already handled"
            subhead="These are logged events from this shop, not a second approval queue."
          />
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
