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
  return <RevenueTilesClient summary={summary} />
}
