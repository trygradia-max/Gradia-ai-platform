"use client"

import * as React from "react"
import Link from "next/link"
import { motion, useReducedMotion, type Variants } from "framer-motion"

import { HeatBadge } from "@/components/gradia/heat-badge"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { SectionHeader } from "@/components/gradia/section-header"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ScoredLead } from "@/lib/data/leads"
import type { LeadRow, LeadStatus } from "@/lib/types/database"

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  quoted: "Quoted",
  booked: "Booked",
}

const STATUS_TONE: Record<LeadStatus, StatusPillTone> = {
  new: "accent",
  quoted: "warn",
  booked: "good",
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

const rowContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.035, delayChildren: 0.1 },
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

export function LiveLeadFeed({
  leads,
}: {
  leads: (LeadRow | ScoredLead)[]
}) {
  const reduce = useReducedMotion()
  const hasHeat = leads.some(
    (l): l is ScoredLead =>
      "heat" in (l as ScoredLead) && Boolean((l as ScoredLead).heat)
  )

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Live feed"
        title={
          <>
            <span className="italic">Everyone</span>{" "}who&apos;s reached out.
          </>
        }
        subhead="Newest first — voice, email, SMS, DMs, the front desk. We catch them, you decide."
      />

      <MotionCard interactive={false} className="overflow-hidden p-0">
        {leads.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border/50 hover:bg-transparent">
                  <TableHead className="label-eyebrow min-w-[120px] pl-4 sm:pl-6">
                    Customer
                  </TableHead>
                  <TableHead className="label-eyebrow hidden sm:table-cell">
                    Phone
                  </TableHead>
                  <TableHead className="label-eyebrow hidden md:table-cell">
                    Vehicle
                  </TableHead>
                  <TableHead className="label-eyebrow hidden lg:table-cell">
                    Notes
                  </TableHead>
                  {hasHeat ? (
                    <TableHead className="label-eyebrow">Heat</TableHead>
                  ) : null}
                  <TableHead className="label-eyebrow">Status</TableHead>
                  <TableHead className="label-eyebrow pr-4 text-right sm:pr-6">
                    When
                  </TableHead>
                </TableRow>
              </TableHeader>
              <motion.tbody
                variants={reduce ? undefined : rowContainer}
                initial={reduce ? undefined : "hidden"}
                animate={reduce ? undefined : "show"}
                className="[&_tr]:border-b [&_tr]:border-border/40"
              >
                {leads.map((lead) => {
                  const heat = (lead as ScoredLead).heat
                  return (
                    <motion.tr
                      key={lead.id}
                      variants={reduce ? undefined : row}
                      className="relative transition-colors duration-200 hover:bg-card/60 focus-within:bg-card/60"
                    >
                      <TableCell className="max-w-[180px] pl-4 font-medium sm:pl-6">
                        {/* Overlay link covers the row for click-anywhere
                            without breaking the table cell semantics for SR users. */}
                        <Link
                          href={`/leads`}
                          aria-label={`Open ${lead.customer_name}`}
                          className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        />
                        <p className="truncate text-foreground">
                          {lead.customer_name}
                        </p>
                        <p className="text-xs tabular-nums font-normal text-muted-foreground sm:hidden">
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
                        <StatusPill tone={STATUS_TONE[lead.status]}>
                          {STATUS_LABEL[lead.status]}
                        </StatusPill>
                      </TableCell>
                      <TableCell
                        suppressHydrationWarning
                        className="pr-4 text-right text-muted-foreground tabular-nums sm:pr-6"
                      >
                        {WHEN.format(new Date(lead.created_at))}
                      </TableCell>
                    </motion.tr>
                  )
                })}
              </motion.tbody>
            </Table>
          </div>
        )}
      </MotionCard>
    </section>
  )
}

function EmptyState() {
  return (
    <div className="px-6 py-16 text-center">
      <p className="font-display text-2xl text-foreground">
        <span className="italic">Quiet</span>{" "}so far.
      </p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        When a lead comes in — voice, email, SMS, DM — we&apos;ll catch
        it here together.
      </p>
      <Link
        href="/settings"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:text-primary/80"
      >
        Connect a channel so leads can arrive →
      </Link>
    </div>
  )
}
