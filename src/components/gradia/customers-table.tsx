"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Search } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CustomerWithCounts } from "@/lib/data/customers"

function formatRelative(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`
  const weeks = Math.round(days / 7)
  return `${weeks} wk${weeks === 1 ? "" : "s"} ago`
}

function channelHints(c: CustomerWithCounts): string {
  const parts: string[] = []
  if (c.phone) parts.push("phone")
  if (c.email) parts.push("email")
  if (c.instagram_handle) parts.push("IG")
  if (c.facebook_id) parts.push("FB")
  return parts.join(" · ") || "—"
}

export function CustomersTable({
  initialQuery,
  customers,
}: {
  initialQuery: string
  customers: CustomerWithCounts[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [query, setQuery] = React.useState(initialQuery)

  // Debounced server-side search via ?q=… on the URL.
  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      if (query.trim()) next.set("q", query.trim())
      else next.delete("q")
      const qs = next.toString()
      router.replace(qs ? `/customers?${qs}` : "/customers", { scroll: false })
    }, 220)
    return () => window.clearTimeout(handle)
    // We only want to fire on query changes — router & searchParams are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  return (
    <div className="grid gap-4">
      <div className="relative max-w-md">
        <Search
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, phone, email, social…"
          className="pl-9"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <Card className="border-border/80 shadow-sm">
        <CardContent className="px-0 pt-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-[140px] pl-4 sm:pl-6">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Phone</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="hidden lg:table-cell">Channels</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="pr-4 text-right sm:pr-6">Last heard</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-14 text-center text-sm text-muted-foreground"
                  >
                    {initialQuery
                      ? "Nobody matches that yet — try a different name or number."
                      : "Quiet so far — customers land here automatically when voice, SMS, or email comes in."}
                  </TableCell>
                </TableRow>
              ) : (
                customers.map((c) => (
                  <TableRow
                    key={c.id}
                    className="relative cursor-pointer transition-colors duration-150 hover:bg-muted/40 focus-within:bg-muted/40"
                  >
                    <TableCell className="max-w-[200px] pl-4 font-medium sm:pl-6">
                      {/* Single overlay link covers the entire row so
                          click-anywhere works without per-cell wrappers
                          or a non-semantic onClick. Cells stay read-
                          only / selectable for screen readers. */}
                      <Link
                        href={`/customers/${c.id}`}
                        aria-label={`Open ${c.name?.trim() || "customer"}`}
                        className="absolute inset-0 z-10 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      />
                      <span className="block truncate">
                        {c.name?.trim() || "Unknown"}
                      </span>
                      <span className="block truncate text-xs tabular-nums font-normal text-muted-foreground sm:hidden">
                        {c.phone ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                      {c.phone ?? "—"}
                    </TableCell>
                    <TableCell className="hidden max-w-[240px] truncate text-muted-foreground md:table-cell">
                      {c.email ?? "—"}
                    </TableCell>
                    <TableCell className="hidden text-xs uppercase tracking-wide text-muted-foreground lg:table-cell">
                      {channelHints(c)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.lead_count}
                    </TableCell>
                    <TableCell className="pr-4 text-right text-muted-foreground tabular-nums sm:pr-6">
                      {formatRelative(c.last_seen_at)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
