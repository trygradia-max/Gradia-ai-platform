import Link from "next/link"
import { notFound } from "next/navigation"
import {
  ArrowLeft,
  Briefcase,
  CalendarDays,
  Mail,
  Phone,
  type LucideIcon,
} from "lucide-react"

import { CustomerMergeDialog } from "@/components/gradia/customer-merge-dialog"
import { HeatBadge } from "@/components/gradia/heat-badge"
import { InteractionTimeline } from "@/components/gradia/interaction-timeline"
import { SmsQuickReply } from "@/components/gradia/sms-quick-reply"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { SectionHeader } from "@/components/gradia/motion/section-header"
import {
  buildHeatContext,
  computeHeatScore,
  type HeatScore,
} from "@/lib/scoring"
import {
  StatusPill,
  type StatusPillTone,
} from "@/components/ui/status-pill"
import { getCustomerDetailForCurrentShop } from "@/lib/data/customers"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type {
  AppointmentRow,
  LeadRow,
  LeadStatus,
  ShopRow,
} from "@/lib/types/database"

export const dynamic = "force-dynamic"

const LEAD_STATUS_TONE: Record<LeadStatus, StatusPillTone> = {
  new: "accent",
  quoted: "warn",
  booked: "good",
}

const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  quoted: "Quoted",
  booked: "Booked",
}

function formatAbsolute(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso))
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const detail = await getCustomerDetailForCurrentShop(id)
  if (!detail) notFound()

  const { customer, interactions, leads, appointments } = detail

  // Determine if Quick Reply should appear: shop has Twilio number
  // AND customer has a phone we can text. Pulled separately so we
  // don't bloat the bundle when the conditions aren't met.
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data: shopRow } = await supabase
    .from("shops")
    .select("twilio_phone_number")
    .eq("id", shopCtx.id)
    .single()
  const shop = shopRow as Pick<ShopRow, "twilio_phone_number"> | null
  const canSms = Boolean(shop?.twilio_phone_number && customer.phone)

  // Heat of the customer's hottest active lead. Operator looks at this
  // first ("should I prioritize this person right now?").
  let hottest: HeatScore | null = null
  if (leads.length > 0) {
    const activeLeads = leads.filter((l) => l.status !== "booked")
    const target = activeLeads.length > 0 ? activeLeads : leads
    const context = await buildHeatContext(supabase, shopCtx.id, target)
    for (const lead of target) {
      const score = computeHeatScore(lead, context)
      if (!hottest || score.score > hottest.score) hottest = score
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/customers"
            className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft
              className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5"
              aria-hidden
            />
            Back to customers
          </Link>
          <div className="flex items-center gap-2">
            <CustomerMergeDialog
              winnerId={customer.id}
              winnerName={customer.name}
            />
          </div>
        </div>
        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">Customer</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
              {customer.name?.trim() || "Unknown customer"}
            </h1>
            {hottest ? <HeatBadge heat={hottest} showScore /> : null}
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">
            One file. Every channel they&apos;ve come through, every
            touchpoint we&apos;ve had with them.
          </p>
        </div>
      </header>

      <IdentityCard customer={customer} />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <InteractionTimeline interactions={interactions} />
        <PipelineCard leads={leads} appointments={appointments} />
      </div>

      {canSms ? (
        <SmsQuickReply
          toPhone={customer.phone!}
          customerName={customer.name}
        />
      ) : null}
    </div>
  )
}

type IdentityRow = {
  icon: LucideIcon
  label: string
  value: string | null
}

function IdentityCard({
  customer,
}: {
  customer: {
    phone: string | null
    email: string | null
    jobber_client_id: string | null
  }
}) {
  const rows: IdentityRow[] = [
    { icon: Phone, label: "Phone", value: customer.phone },
    { icon: Mail, label: "Email", value: customer.email },
  ]
  if (customer.jobber_client_id) {
    rows.push({
      icon: Briefcase,
      label: "Jobber",
      value: "Synced",
    })
  }
  const filledRows = rows.filter(
    (r) => r.value && r.value.trim().length > 0
  )

  return (
    <section className="space-y-4">
      <SectionHeader
        eyebrow="Identity"
        title={
          <>
            How we <span className="italic">reach</span> them.
          </>
        }
        subtitle="One record. Every channel we've linked to this person."
      />

      <MotionCard interactive={false} className="overflow-hidden p-5 sm:p-6">
        {filledRows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No channels linked yet — they&apos;ll show up here the first
            time they call, text, or DM us.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {filledRows.map((r) => {
              const Icon = r.icon
              return (
                <li
                  key={r.label}
                  className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3 py-2.5"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/60 text-muted-foreground ring-1 ring-border/50">
                    <Icon className="size-3.5" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="label-eyebrow text-muted-foreground/70">
                      {r.label}
                    </p>
                    <p className="truncate text-sm font-medium text-foreground tabular-nums">
                      {r.value}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </MotionCard>
    </section>
  )
}

function PipelineCard({
  leads,
  appointments,
}: {
  leads: LeadRow[]
  appointments: AppointmentRow[]
}) {
  const totalCount = leads.length + appointments.length

  return (
    <section className="space-y-4">
      <SectionHeader
        eyebrow="Pipeline"
        title={
          <>
            What we&apos;ve <span className="italic">worked</span>.
          </>
        }
        subtitle={
          totalCount === 0
            ? "Nothing in motion yet."
            : `${leads.length} lead${leads.length === 1 ? "" : "s"}, ${appointments.length} on the books.`
        }
      />

      <MotionCard interactive={false} className="overflow-hidden p-5 sm:p-6">
        <div className="space-y-5">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="label-eyebrow text-muted-foreground/70">
                Leads
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {leads.length}
              </p>
            </div>
            {leads.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No leads yet.
              </p>
            ) : (
              <ul className="grid gap-2">
                {leads.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/15 px-3 py-2.5"
                  >
                    <span className="truncate text-sm text-foreground/90">
                      {l.pin_notes?.trim() || l.car_info?.trim() || "Lead"}
                    </span>
                    <StatusPill
                      tone={LEAD_STATUS_TONE[l.status]}
                      className="shrink-0"
                    >
                      {LEAD_STATUS_LABEL[l.status]}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2.5 border-t border-border/40 pt-5">
            <div className="flex items-center justify-between gap-2">
              <p className="label-eyebrow text-muted-foreground/70">
                Appointments
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {appointments.length}
              </p>
            </div>
            {appointments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None on the books.
              </p>
            ) : (
              <ul className="grid gap-2">
                {appointments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3 py-2.5"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/25 dark:text-emerald-400">
                      <CalendarDays className="size-3.5" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {a.service_name?.trim() || "Detail"}
                        {a.duration_minutes ? (
                          <span className="text-muted-foreground">
                            {" "}· {a.duration_minutes} min
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {formatAbsolute(a.scheduled_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </MotionCard>
    </section>
  )
}
