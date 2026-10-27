"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { EmptyState } from "@/components/gradia/empty-state"
import { FormField } from "@/components/gradia/form-field"
import { ListToolbar } from "@/components/gradia/list-toolbar"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CustomerWithCounts } from "@/lib/data/customers"
import { STRINGS } from "@/lib/strings"

const LIST_CAP = 200

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

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      if (query.trim()) next.set("q", query.trim())
      else next.delete("q")
      const qs = next.toString()
      router.replace(qs ? `/customers?${qs}` : "/customers", {
        scroll: false,
      })
    }, 220)
    return () => window.clearTimeout(handle)
    // We only want to fire on query changes — router & searchParams are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const capped = customers.length >= LIST_CAP
  const countLabel =
    customers.length === 0
      ? initialQuery
        ? "No match on this search"
        : "Nobody yet"
      : capped
        ? `Showing the first ${LIST_CAP}. Search to find someone else.`
        : `${customers.length} ${customers.length === 1 ? "customer" : "customers"}`

  return (
    <div className="space-y-5">
      <ListToolbar
        label="Customer search"
        search={
          <div className="w-full sm:max-w-sm">
            <FormField
              id="customer-search"
              label="Search customers"
              hint="Matches name, phone, or email on this shop. This is not a full-database filter."
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, phone, or email"
                className="h-11"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
          </div>
        }
        status={
          <p className="text-sm text-muted-foreground sm:text-right">{countLabel}</p>
        }
      />

      {customers.length === 0 ? (
        <EmptyState
          title={
            initialQuery
              ? "Nobody by that name yet."
              : STRINGS.empty.customersFirstUseTitle
          }
          description={
            initialQuery
              ? "Try a different name or number."
              : STRINGS.empty.customersFirstUse
          }
          action={
            !initialQuery ? (
              <Link
                href="/customers/recovery"
                className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text underline-offset-4 hover:underline"
              >
                Import your customers
              </Link>
            ) : null
          }
        />
      ) : (
        <div
          role="region"
          aria-label="Customer list"
          tabIndex={0}
          className="overflow-x-auto rounded-md bg-card ring-1 ring-border"
        >
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="label-eyebrow min-w-[140px] pl-4 sm:pl-6">
                  Name
                </TableHead>
                <TableHead className="label-eyebrow hidden sm:table-cell">
                  Phone
                </TableHead>
                <TableHead className="label-eyebrow hidden md:table-cell">
                  Email
                </TableHead>
                <TableHead className="label-eyebrow hidden lg:table-cell">
                  Channels
                </TableHead>
                <TableHead className="label-eyebrow text-right">Leads</TableHead>
                <TableHead className="label-eyebrow pr-4 text-right sm:pr-6">
                  Last heard
                </TableHead>
              </TableRow>
            </TableHeader>
            <tbody className="[&_tr]:border-b [&_tr]:border-border">
              {customers.map((c) => (
                <TableRow
                  key={c.id}
                  className="relative hover:bg-accent focus-within:bg-accent"
                >
                  <TableCell className="max-w-[200px] pl-4 font-medium sm:pl-6">
                    <Link
                      href={`/customers/${c.id}`}
                      aria-label={`Open ${c.name?.trim() || "customer"}`}
                      className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    />
                    <span className="block truncate text-foreground">
                      {c.name?.trim() || "Unknown"}
                    </span>
                    <span className="block truncate font-data text-xs font-normal text-muted-foreground sm:hidden">
                      {c.phone ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell className="hidden font-data text-muted-foreground sm:table-cell">
                    {c.phone ?? "—"}
                  </TableCell>
                  <TableCell className="hidden max-w-[240px] truncate text-muted-foreground md:table-cell">
                    {c.email ?? "—"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="label-eyebrow text-muted-foreground">
                      {channelHints(c)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-data text-muted-foreground">
                    {c.lead_count}
                  </TableCell>
                  <TableCell
                    suppressHydrationWarning
                    className="pr-4 text-right font-data text-muted-foreground sm:pr-6"
                  >
                    {formatRelative(c.last_seen_at)}
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  )
}
