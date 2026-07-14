import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { ActivityEvent } from "@/components/gradia/activity-event"
import { ApprovalsList } from "@/components/gradia/approvals-list"
import { SectionHeader } from "@/components/gradia/section-header"
import {
  listOpenApprovalsForCurrentShop,
  listRecentAgentActivity,
} from "@/lib/data/pending-actions"
import { STRINGS } from "@/lib/strings"

/**
 * The Home live feed (FOCUS spec §4.3, item 3): what's waiting on a yes +
 * what we already handled — inline, so the daily loop (glance → approve)
 * happens without leaving Home. Approvals here are the SAME optimistic,
 * one-tap cards as the /approvals page (capped to a few; full queue is one
 * tap away). Renders nothing when there's neither — the receipt + nudges
 * above already carry the page, and we never show an empty box.
 */
const HOME_CAP = 3

export async function HomeFeed() {
  const [pending, activity] = await Promise.all([
    listOpenApprovalsForCurrentShop(),
    listRecentAgentActivity(5),
  ])

  if (pending.length === 0 && activity.length === 0) return null

  const shown = pending.slice(0, HOME_CAP)
  const overflow = pending.length - shown.length

  return (
    <div className="space-y-10">
      {pending.length > 0 ? (
        <section className="space-y-5">
          <SectionHeader
            eyebrow={STRINGS.chrome.waitingOnYou}
            title="What needs a yes"
            subhead="A quick yes or no before anything leaves the shop — approve right here."
          />
          <ApprovalsList items={shown} />
          {overflow > 0 ? (
            <Link
              href="/approvals"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
            >
              See all {pending.length} waiting
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </section>
      ) : null}

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
