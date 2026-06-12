import { getRevenueSummaryForCurrentShop } from "@/lib/data/revenue"

import { RevenueTilesClient } from "./revenue-tiles-client"

/**
 * Server-fetches the revenue rollup, hands it to the animated
 * client component. Keeping the data load on the server means the
 * stats are SSR-correct on first paint — the client just owns the
 * count-up animation.
 */
export async function RevenueTiles() {
  const summary = await getRevenueSummaryForCurrentShop()
  // A wall of $0 cards on day one reads as failure, not potential — the
  // tiles earn their spot once there's a single dollar to show
  // (GRADIA_UX_ONBOARDING_SPEC Part 2).
  if (summary.all_time.cents === 0) return null
  return <RevenueTilesClient summary={summary} />
}
