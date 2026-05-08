import type { LeadRow, LeadStatus } from "@/lib/types/database"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

export function LiveLeadFeed({ leads }: { leads: LeadRow[] }) {
  return (
    <Card className="border-border/80 shadow-sm transition-shadow duration-200">
      <CardHeader className="flex flex-col gap-1 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg font-semibold tracking-tight">
            Live lead feed
          </CardTitle>
          <CardDescription>
            Newest signals first — wired for AI follow-ups next.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="min-w-[120px] pl-6">Customer</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="hidden md:table-cell">Vehicle</TableHead>
              <TableHead className="hidden lg:table-cell">Notes</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-6 text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-14 text-center text-sm text-muted-foreground"
                >
                  No leads yet — let&apos;s capture our first with Quick add lead.
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="transition-colors duration-150"
                >
                  <TableCell className="max-w-[180px] pl-6 font-medium">
                    {lead.customer_name}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {lead.phone}
                  </TableCell>
                  <TableCell className="hidden max-w-[220px] truncate text-muted-foreground md:table-cell">
                    {lead.car_info ?? "—"}
                  </TableCell>
                  <TableCell className="hidden max-w-[280px] truncate text-muted-foreground lg:table-cell">
                    {lead.pin_notes ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(lead.status)}>
                      {statusLabel[lead.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-6 text-right text-muted-foreground tabular-nums">
                    {formatWhen(lead.created_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
