import type { LeadRow, LeadStatus } from "@/lib/types/database"
import type { ScoredLead } from "@/lib/data/leads"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { HeatBadge } from "@/components/gradia/heat-badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const statusLabel: Record<LeadStatus, string> = {
  new: "New",
  quoted: "Quoted",
  booked: "Booked",
}

function statusBadgeVariant(
  status: LeadStatus
): "default" | "secondary" | "outline" {
  switch (status) {
    case "new":
      return "default"
    case "quoted":
      return "secondary"
    case "booked":
      return "outline"
    default:
      return "outline"
  }
}

function formatWhen(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso))
}

export function LiveLeadFeed({
  leads,
}: {
  leads: (LeadRow | ScoredLead)[]
}) {
  // Renders the Heat column only when callers passed ScoredLeads.
  // /dashboard + /leads pass scored; older surfaces can still call us
  // with bare LeadRows during the transition.
  const hasHeat = leads.some(
    (l): l is ScoredLead => "heat" in (l as ScoredLead) && Boolean((l as ScoredLead).heat)
  )
  return (
    <Card className="border-border/80 shadow-sm transition-shadow duration-200">
      <CardHeader className="flex flex-col gap-1 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg font-semibold tracking-tight">
            Latest leads
          </CardTitle>
          <CardDescription>
            Newest first — everyone we&apos;ve heard from across voice, email,
            and the front desk.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="min-w-[120px] pl-4 sm:pl-6">Customer</TableHead>
              <TableHead className="hidden sm:table-cell">Phone</TableHead>
              <TableHead className="hidden md:table-cell">Vehicle</TableHead>
              <TableHead className="hidden lg:table-cell">Notes</TableHead>
              {hasHeat ? <TableHead>Heat</TableHead> : null}
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right sm:pr-6">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={hasHeat ? 7 : 6}
                  className="py-14 text-center text-sm text-muted-foreground"
                >
                  Quiet so far — when a lead comes in, we&apos;ll catch it here together.
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => {
                const heat = (lead as ScoredLead).heat
                return (
                  <TableRow
                    key={lead.id}
                    className="transition-colors duration-150"
                  >
                    <TableCell className="max-w-[180px] pl-4 font-medium sm:pl-6">
                      <p className="truncate">{lead.customer_name}</p>
                      <p className="tabular-nums text-xs text-muted-foreground sm:hidden">
                        {lead.phone}
                      </p>
                    </TableCell>
                    <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                      {lead.phone}
                    </TableCell>
                    <TableCell className="hidden max-w-[220px] truncate text-muted-foreground md:table-cell">
                      {lead.car_info ?? "—"}
                    </TableCell>
                    <TableCell className="hidden max-w-[280px] truncate text-muted-foreground lg:table-cell">
                      {lead.pin_notes ?? "—"}
                    </TableCell>
                    {hasHeat ? (
                      <TableCell>
                        {heat ? <HeatBadge heat={heat} /> : null}
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <Badge variant={statusBadgeVariant(lead.status)}>
                        {statusLabel[lead.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-4 text-right text-muted-foreground tabular-nums sm:pr-6">
                      {formatWhen(lead.created_at)}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
