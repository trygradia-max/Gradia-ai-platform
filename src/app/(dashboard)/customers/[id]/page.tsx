import Link from "next/link"
import { notFound } from "next/navigation"
import {
  AtSign,
  Briefcase,
  CalendarDays,
  Globe,
  Mail,
  Phone,
  Sparkles,
  User,
} from "lucide-react"

import { CustomerMergeDialog } from "@/components/gradia/customer-merge-dialog"
import { HeatBadge } from "@/components/gradia/heat-badge"
import { SmsQuickReply } from "@/components/gradia/sms-quick-reply"
import {
  buildHeatContext,
  computeHeatScore,
  type HeatScore,
} from "@/lib/scoring"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getCustomerDetailForCurrentShop } from "@/lib/data/customers"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type {
  AppointmentRow,
  InteractionChannel,
  InteractionRow,
  LeadRow,
  ShopRow,
} from "@/lib/types/database"

export const dynamic = "force-dynamic"

const CHANNEL_LABEL: Record<InteractionChannel, string> = {
  voice: "Call",
  sms: "SMS",
  email: "Email",
  instagram: "Instagram",
  facebook: "Facebook",
  web: "Web",
  note: "Note",
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
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`
  const weeks = Math.round(days / 7)
  return `${weeks} wk${weeks === 1 ? "" : "s"} ago`
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
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {customer.name?.trim() || "Unknown customer"}
            </h1>
            {hottest ? <HeatBadge heat={hottest} showScore /> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Everything we know — and every touchpoint, across every channel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CustomerMergeDialog
            winnerId={customer.id}
            winnerName={customer.name}
          />
          <Link
            href="/customers"
            className={buttonVariants({ variant: "ghost" })}
          >
            Back
          </Link>
        </div>
      </div>

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

function IdentityCard({ customer }: { customer: { phone: string | null; email: string | null; instagram_handle: string | null; facebook_id: string | null; jobber_client_id: string | null } }) {
  const rows: { icon: React.ReactNode; label: string; value: string | null }[] = [
    { icon: <Phone className="size-4" aria-hidden />, label: "Phone", value: customer.phone },
    { icon: <Mail className="size-4" aria-hidden />, label: "Email", value: customer.email },
    {
      icon: <AtSign className="size-4" aria-hidden />,
      label: "Instagram",
      value: customer.instagram_handle ? `@${customer.instagram_handle}` : null,
    },
    {
      icon: <Globe className="size-4" aria-hidden />,
      label: "Facebook",
      value: customer.facebook_id,
    },
  ]
  if (customer.jobber_client_id) {
    rows.push({
      icon: <Briefcase className="size-4" aria-hidden />,
      label: "Jobber",
      value: "Synced",
    })
  }
  // Drop empty rows so customers with only a phone don't get three
  // rows of "—" filler. If literally nothing is linked, fall through
  // to a single explanatory empty state below.
  const filledRows = rows.filter((r) => r.value && r.value.trim().length > 0)
  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <User className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <CardTitle className="text-base font-medium">Identity</CardTitle>
          <p className="text-sm text-muted-foreground">
            One record. Every channel we&apos;ve linked to them.
          </p>
        </div>
      </CardHeader>
      <CardContent
        className={
          filledRows.length === 0
            ? "py-6 text-center text-sm text-muted-foreground"
            : "grid gap-3 sm:grid-cols-2"
        }
      >
        {filledRows.length === 0 ? (
          <p>
            No channels linked yet — they&apos;ll show up here the first
            time they call, text, or DM us.
          </p>
        ) : null}
        {filledRows.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground">{r.icon}</span>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {r.label}
            </span>
            <span className="ml-auto truncate font-medium">
              {r.value}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

type StatusBadge = {
  label: string
  tone: "good" | "bad" | "neutral"
  hint?: string | null
}

function pickStatusBadge(it: InteractionRow): StatusBadge | null {
  const meta = (it.metadata as Record<string, unknown> | null) ?? {}
  // Outbound SMS — Twilio status callback writes here.
  if (it.channel === "sms" && meta.direction === "outbound") {
    const status =
      typeof meta.twilio_status === "string"
        ? meta.twilio_status.toLowerCase()
        : ""
    const errorCode =
      meta.twilio_error_code != null ? String(meta.twilio_error_code) : null
    if (status === "delivered") return { label: "Delivered", tone: "good" }
    if (status === "failed" || status === "undelivered") {
      return {
        label: "Failed",
        tone: "bad",
        hint: errorCode ? `Twilio error ${errorCode}` : null,
      }
    }
    if (status === "sent") return { label: "Sent", tone: "neutral" }
    if (status === "queued") return { label: "Queued", tone: "neutral" }
  }
  // Charges land as channel=note with Stripe metadata.
  if (it.channel === "note" && typeof meta.stripe_invoice_id === "string") {
    const refundStatus =
      typeof meta.stripe_refund_status === "string"
        ? meta.stripe_refund_status.toLowerCase()
        : ""
    if (refundStatus === "refunded") {
      return { label: "Refunded", tone: "bad" }
    }
    if (refundStatus === "partially_refunded") {
      return { label: "Partial refund", tone: "bad" }
    }
    const status =
      typeof meta.stripe_payment_status === "string"
        ? meta.stripe_payment_status.toLowerCase()
        : ""
    if (status === "paid") return { label: "Paid", tone: "good" }
    if (status === "payment_failed") {
      return { label: "Payment failed", tone: "bad" }
    }
    return { label: "Invoice sent", tone: "neutral" }
  }
  return null
}

function renderStatusBadge(it: InteractionRow): React.ReactNode {
  const badge = pickStatusBadge(it)
  if (!badge) return null
  const className =
    badge.tone === "good"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : badge.tone === "bad"
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground"
  return (
    <span
      title={badge.hint ?? undefined}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}
    >
      {badge.label}
    </span>
  )
}

function InteractionTimeline({ interactions }: { interactions: InteractionRow[] }) {
  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Sparkles className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <CardTitle className="text-base font-medium">Activity</CardTitle>
          <p className="text-sm text-muted-foreground">
            The last 50 touchpoints across every channel, newest first.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {interactions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No touchpoints yet — we&apos;ll fill this in the moment they reach
            out.
          </p>
        ) : (
          <ul className="grid gap-2">
            {interactions.map((it) => (
              <li
                key={it.id}
                className="grid gap-1 rounded-md border border-border/60 bg-muted/15 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-normal">
                      {CHANNEL_LABEL[it.channel] ?? it.channel}
                    </Badge>
                    <span className="text-[11px] uppercase tracking-wide">
                      {it.role === "customer"
                        ? "from them"
                        : it.role === "gradia"
                          ? "from us"
                          : "system"}
                    </span>
                    {renderStatusBadge(it)}
                  </span>
                  <span title={new Date(it.occurred_at).toISOString()}>
                    {formatRelative(it.occurred_at)}
                  </span>
                </div>
                <p className="whitespace-pre-line text-sm">
                  {it.content.length > 360
                    ? `${it.content.slice(0, 360)}…`
                    : it.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function PipelineCard({
  leads,
  appointments,
}: {
  leads: LeadRow[]
  appointments: AppointmentRow[]
}) {
  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <CalendarDays className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <CardTitle className="text-base font-medium">
            Leads &amp; bookings
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Everything we&apos;ve worked for them so far.
          </p>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Leads
          </p>
          {leads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads yet.</p>
          ) : (
            <ul className="grid gap-2">
              {leads.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm"
                >
                  <span className="truncate">
                    {l.pin_notes?.trim() || l.car_info?.trim() || "Lead"}
                  </span>
                  <Badge variant="secondary" className="ml-3 shrink-0">
                    {l.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Appointments
          </p>
          {appointments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None on the books.
            </p>
          ) : (
            <ul className="grid gap-2">
              {appointments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm"
                >
                  <span className="truncate">
                    {a.service_name?.trim() || "Detail"}
                    {a.duration_minutes
                      ? ` · ${a.duration_minutes} min`
                      : ""}
                  </span>
                  <span className="ml-3 shrink-0 tabular-nums text-muted-foreground">
                    {formatAbsolute(a.scheduled_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
