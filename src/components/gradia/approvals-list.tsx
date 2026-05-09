"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  approveFromDashboard,
  rejectFromDashboard,
} from "@/app/actions/approvals"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import type { LeadStatus, PendingActionRow } from "@/lib/types/database"

type LeadProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

export function ApprovalsList({ items }: { items: PendingActionRow[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | null>(null)

  if (items.length === 0) {
    return (
      <Card className="border-border/80">
        <CardContent className="py-14 text-center text-sm text-muted-foreground">
          All caught up — nothing waiting on us.
        </CardContent>
      </Card>
    )
  }

  async function handleDecision(
    id: string,
    decision: "approve" | "reject"
  ): Promise<void> {
    const key = `${id}:${decision}`
    setBusyId(key)
    const result =
      decision === "approve"
        ? await approveFromDashboard(id)
        : await rejectFromDashboard(id)
    setBusyId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    if (result.alreadyDecided) {
      toast.message("Already decided — refreshing")
    } else if (decision === "approve") {
      toast.success("Lead saved to our pipeline")
    } else {
      toast.success("Dropped")
    }

    router.refresh()
  }

  return (
    <ul className="grid gap-4">
      {items.map((item) => {
        const proposal = item.payload as unknown as LeadProposal
        const isEditRequested = item.status === "edit_requested"
        const approveBusy = busyId === `${item.id}:approve`
        const rejectBusy = busyId === `${item.id}:reject`
        const anyBusy = approveBusy || rejectBusy

        return (
          <li key={item.id}>
            <Card className="border-border/80 shadow-sm">
              <CardHeader className="flex flex-col gap-3 pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-medium">
                      {proposal.customer_name || "Unknown caller"}
                    </p>
                    <p className="text-sm tabular-nums text-muted-foreground">
                      {proposal.phone}
                    </p>
                  </div>
                  <Badge variant={isEditRequested ? "outline" : "default"}>
                    {isEditRequested ? "Edit needed" : "Pending"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pb-4 pt-0">
                {proposal.car_info ? (
                  <p className="text-sm">{proposal.car_info}</p>
                ) : null}
                {proposal.pin_notes ? (
                  <p className="text-sm text-muted-foreground">
                    {proposal.pin_notes}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Submitted {formatRelative(item.created_at)}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
                  <Button
                    onClick={() => handleDecision(item.id, "approve")}
                    disabled={anyBusy}
                    className="gap-2 transition-transform duration-200 active:scale-[0.99]"
                  >
                    {approveBusy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    Approve
                  </Button>
                  <Button
                    onClick={() => handleDecision(item.id, "reject")}
                    disabled={anyBusy}
                    variant="outline"
                    className="gap-2 transition-transform duration-200 active:scale-[0.99]"
                  >
                    {rejectBusy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
