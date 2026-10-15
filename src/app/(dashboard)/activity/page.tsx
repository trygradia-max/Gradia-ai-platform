import { ActivityFeed } from "@/components/gradia/activity-feed"
import { SectionHeader } from "@/components/gradia/section-header"
import { listActivityFeed } from "@/lib/data/activity"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"

export const dynamic = "force-dynamic"

/**
 * Activity — the glass box (spec §5.1 / §8-A4), now fed by real data
 * (L4-lite): call_records + pending_actions + fired custom_agent_runs,
 * with "because" lines only where the decision log has rows.
 */
export default async function ActivityPage() {
  await requireShop()
  const items = await listActivityFeed()
  const s = STRINGS.pages.activity

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <SectionHeader
        level={1}
        eyebrow={s.eyebrow}
        title={s.title}
        subhead={s.subtitle}
      />

      <ActivityFeed items={items} />
    </div>
  )
}
