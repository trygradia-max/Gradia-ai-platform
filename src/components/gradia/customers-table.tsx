"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { motion, useReducedMotion, type Variants } from "framer-motion"
import { Search } from "lucide-react"

import { MotionCard } from "@/components/gradia/motion/motion-card"
import { Input } from "@/components/ui/input"
import {
  Table,
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
  return parts.join(" · ") || "—"
}

const rowContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03, delayChildren: 0.08 },
  },
}

const row: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: "easeOut" },
  },
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
  const reduce = useReducedMotion()
  const [query, setQuery] = React.useState(initialQuery)

  // Debounced server-side search via ?q=… on the URL.
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, phone, email, social…"
            className="h-10 pl-9"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className="label-eyebrow text-muted-foreground/70 sm:text-right">
          {customers.length === 0
            ? initialQuery
              ? "No match"
              : "Nobody yet"
            : `${customers.length} ${
                customers.length === 1 ? "customer" : "customers"
              }`}
        </p>
      </div>

      <MotionCard interactive={false} className="overflow-hidden p-0">
        {customers.length === 0 ? (
          <EmptyState searching={Boolean(initialQuery)} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border/50 hover:bg-transparent">
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
                  <TableHead className="label-eyebrow text-right">
                    Leads
                  </TableHead>
                  <TableHead className="label-eyebrow pr-4 text-right sm:pr-6">
                    Last heard
                  </TableHead>
                </TableRow>
              </TableHeader>
              <motion.tbody
                key={initialQuery /* re-stagger when search changes results */}
                variants={reduce ? undefined : rowContainer}
                initial={reduce ? undefined : "hidden"}
                animate={reduce ? undefined : "show"}
                className="[&_tr]:border-b [&_tr]:border-border/40"
              >
                {customers.map((c) => (
                  <motion.tr
                    key={c.id}
                    variants={reduce ? undefined : row}
                    className="relative transition-colors duration-200 hover:bg-card/60 focus-within:bg-card/60"
                  >
                    <TableCell className="max-w-[200px] pl-4 font-medium sm:pl-6">
                      {/* Overlay link makes the whole row clickable while
                          keeping table cells selectable for screen readers. */}
                      <Link
                        href={`/customers/${c.id}`}
                        aria-label={`Open ${c.name?.trim() || "customer"}`}
                        className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      />
                      <span className="block truncate text-foreground">
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
                    <TableCell className="hidden lg:table-cell">
                      <span className="label-eyebrow !text-muted-foreground/80">
                        {channelHints(c)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.lead_count}
                    </TableCell>
                    <TableCell
                      suppressHydrationWarning
                      className="pr-4 text-right tabular-nums text-muted-foreground sm:pr-6"
                    >
                      {formatRelative(c.last_seen_at)}
                    </TableCell>
                  </motion.tr>
                ))}
              </motion.tbody>
            </Table>
          </div>
        )}
      </MotionCard>
    </div>
  )
}

function EmptyState({ searching }: { searching: boolean }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="font-display text-2xl text-foreground">
        {searching ? (
          <>
            <span className="italic">Nobody</span>{" "}by that name yet.
          </>
        ) : (
          <>
            <span className="italic">Quiet</span>{" "}so far.
          </>
        )}
      </p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        {searching
          ? "Try a different name or number — we'll keep looking."
          : "Customers land here automatically the moment voice, SMS, email, or DMs come in."}
      </p>
      {!searching ? (
        <Link
          href="/recovery"
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:text-primary/80"
        >
          Import your customers →
        </Link>
      ) : null}
    </div>
  )
}
