"use client"

import * as React from "react"
import { CheckCircle2, Sparkles, Users } from "lucide-react"

import { dismissCrmCleanup, mergeCustomers } from "@/app/actions/crm-cleanup"
import { Button } from "@/components/ui/button"
import type { CrmHealth, DuplicateCluster } from "@/lib/crm-health"

/**
 * CRM cleanup card — the connect/import "win". Shows what's messy (duplicates,
 * missing contact info) and lets the owner fix it in a tap, so Gradia starts
 * with clean data. Merging a cluster folds the rest into the first record.
 */
export function CrmCleanupCard({
  health,
  justConnected = false,
}: {
  health: CrmHealth
  justConnected?: boolean
}) {
  const [clusters, setClusters] = React.useState<DuplicateCluster[]>(
    health.duplicateClusters
  )
  const missingContact = health.missingContact.length
  const [pending, startTransition] = React.useTransition()
  const [dismissed, setDismissed] = React.useState(false)

  const clean =
    clusters.length === 0 && missingContact === 0 && health.missingVehicle === 0

  if (dismissed) return null
  if (health.total === 0 && !justConnected) return null

  const dismiss = () =>
    startTransition(async () => {
      await dismissCrmCleanup()
      setDismissed(true)
    })

  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" aria-hidden />
          <h3 className="font-display text-lg text-foreground">
            {justConnected ? "Your CRM is connected — let's tidy it up" : "Tidy up the books"}
          </h3>
        </div>
        {justConnected && (
          <Button variant="ghost" size="sm" onClick={dismiss} disabled={pending}>
            Done
          </Button>
        )}
      </div>

      {health.total === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No customers yet — Gradia will keep this clean as they come in.
        </p>
      ) : clean ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-[var(--status-live,#3fb950)]" aria-hidden />
          {health.total} customers, all reachable and de-duped. Gradia&rsquo;s
          working from clean data.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            {health.total} customers ·{" "}
            {missingContact > 0 && (
              <span>{missingContact} with no phone or email · </span>
            )}
            {health.missingVehicle > 0 && (
              <span>{health.missingVehicle} with no vehicle · </span>
            )}
            {clusters.length > 0 ? (
              <span>{clusters.length} possible duplicate{clusters.length === 1 ? "" : "s"}</span>
            ) : (
              <span>no duplicates</span>
            )}
          </p>

          {clusters.length > 0 && (
            <ul className="mt-4 space-y-2">
              {clusters.slice(0, 8).map((cluster) => {
                const primary = cluster.members[0]
                const desc = (m: DuplicateCluster["members"][number]) =>
                  [m.vehicle_color, m.vehicle_make, m.vehicle_model]
                    .filter(Boolean)
                    .join(" ") ||
                  m.phone ||
                  m.email ||
                  "no details"
                return (
                  <li
                    key={cluster.key}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3 py-2"
                  >
                    <div className="min-w-0 text-sm">
                      <span className="font-medium text-foreground">
                        {primary.name ?? "Unnamed"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        — {cluster.members.length} records ({cluster.members.map(desc).join("; ")})
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          for (const dupe of cluster.members.slice(1)) {
                            const res = await mergeCustomers(primary.id, dupe.id)
                            if (!res.ok) break
                          }
                          setClusters((cur) =>
                            cur.filter((c) => c.key !== cluster.key)
                          )
                        })
                      }
                    >
                      <Sparkles className="mr-1.5 size-4" aria-hidden /> Merge
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}

          {missingContact > 0 && clusters.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Open a customer&rsquo;s file to add a missing phone, email, or
              vehicle — or let Gradia ask for it next time they come in.
            </p>
          )}
        </>
      )}
    </div>
  )
}
