import { ActivityFeed } from "@/components/gradia/activity-feed"
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
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">{s.eyebrow}</p>
        <h1 className="font-display text-2xl text-foreground">{s.title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {s.subtitle}
        </p>
      </header>

      <ActivityFeed items={items} />
    </div>
  )
}
