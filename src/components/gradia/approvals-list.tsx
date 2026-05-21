"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  approveFromDashboard,
  rejectFromDashboard,
} from "@/app/actions/approvals"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import type { LeadStatus, PendingActionRow } from "@/lib/types/database"

type LeadProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
}

type NoteProposal = {
  content: string
  customer_name: string | null
  phone: string | null
}

type BookingProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  service: string | null
  iso_start_time: string
  duration_minutes: number
  timezone: string | null
  pin_notes: string | null
}

type SmsProposal = {
  to_phone: string
  body: string
  customer_name: string | null
  reason: string | null
}

type ChargeProposal = {
  customer_name: string
  customer_email: string
  amount_cents: number
  description: string
}

type EmailProposal = {
  to_email: string
  subject: string
  body: string
  customer_name: string | null
  reason: string | null
}

type InstagramDmProposal = {
  recipient_id: string
  body: string
  customer_name: string | null
  reason: string | null
}

type FacebookDmProposal = {
  recipient_id: string
  body: string
  customer_name: string | null
  reason: string | null
}

function formatMoney(cents: number): string {
  const dollars = cents / 100
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(dollars)
}

function formatBookingWhen(iso: string, minutes: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }
  return `${new Intl.DateTimeFormat(undefined, opts).format(d)} · ${minutes} min`
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
          All clear — nothing waiting on us right now.
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
      toast.success("Saved")
    } else {
      toast.success("Dropped")
    }

    router.refresh()
  }

  return (
    <ul className="grid gap-4">
      {items.map((item) => {
        const isEditRequested = item.status === "edit_requested"
        const approveBusy = busyId === `${item.id}:approve`
        const rejectBusy = busyId === `${item.id}:reject`
        const anyBusy = approveBusy || rejectBusy
        const isNote = item.action_type === "add_note"
        const isBooking = item.action_type === "book_appointment"
        const isSms = item.action_type === "send_sms"
        const isCharge = item.action_type === "charge_customer"
        const isEmail = item.action_type === "send_email"
        const isInstagramDm = item.action_type === "send_instagram_dm"
        const isFacebookDm = item.action_type === "send_facebook_dm"

        return (
          <li key={item.id}>
            <Card className="border-border/80 shadow-sm">
              <CardHeader className="flex flex-col gap-3 pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    {isNote
                      ? renderNoteHeader(item.payload as unknown as NoteProposal)
                      : isBooking
                        ? renderBookingHeader(
                            item.payload as unknown as BookingProposal
                          )
                        : isSms
                          ? renderSmsHeader(item.payload as unknown as SmsProposal)
                          : isCharge
                            ? renderChargeHeader(
                                item.payload as unknown as ChargeProposal
                              )
                            : isEmail
                              ? renderEmailHeader(
                                  item.payload as unknown as EmailProposal
                                )
                              : isInstagramDm
                                ? renderInstagramHeader(
                                    item.payload as unknown as InstagramDmProposal
                                  )
                                : isFacebookDm
                                  ? renderFacebookHeader(
                                      item.payload as unknown as FacebookDmProposal
                                    )
                                  : renderLeadHeader(
                                      item.payload as unknown as LeadProposal
                                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isNote ? (
                      <Badge variant="secondary">Note</Badge>
                    ) : null}
                    {isBooking ? (
                      <Badge variant="secondary">Booking</Badge>
                    ) : null}
                    {isSms ? (
                      <Badge variant="secondary">SMS</Badge>
                    ) : null}
                    {isCharge ? (
                      <Badge variant="secondary">Charge</Badge>
                    ) : null}
                    {isEmail ? (
                      <Badge variant="secondary">Email</Badge>
                    ) : null}
                    {isInstagramDm ? (
                      <Badge variant="secondary">IG DM</Badge>
                    ) : null}
                    {isFacebookDm ? (
                      <Badge variant="secondary">FB DM</Badge>
                    ) : null}
                    <Badge variant={isEditRequested ? "outline" : "default"}>
                      {isEditRequested ? "Edit needed" : "Pending"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pb-4 pt-0">
                {isNote
                  ? renderNoteBody(item.payload as unknown as NoteProposal)
                  : isBooking
                    ? renderBookingBody(
                        item.payload as unknown as BookingProposal
                      )
                    : isSms
                      ? renderSmsBody(item.payload as unknown as SmsProposal)
                      : isCharge
                        ? renderChargeBody(
                            item.payload as unknown as ChargeProposal
                          )
                        : isEmail
                          ? renderEmailBody(
                              item.payload as unknown as EmailProposal
                            )
                          : isInstagramDm
                            ? renderInstagramBody(
                                item.payload as unknown as InstagramDmProposal
                              )
                            : isFacebookDm
                              ? renderFacebookBody(
                                  item.payload as unknown as FacebookDmProposal
                                )
                              : renderLeadBody(
                                  item.payload as unknown as LeadProposal
                                )}
                <p className="text-xs text-muted-foreground">
                  Caught {formatRelative(item.created_at)}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
                  <Button
                    onClick={() => handleDecision(item.id, "approve")}
                    disabled={anyBusy}
                    className="h-11 gap-2 transition-transform duration-200 active:scale-[0.99] sm:h-9 sm:flex-none"
                  >
                    {approveBusy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    Approve
                  </Button>
                  <div className="grid grid-cols-2 gap-2 sm:contents">
                    <Link
                      href={`/approvals/${item.id}`}
                      className={`${buttonVariants({ variant: "outline" })} h-11 sm:h-9`}
                      aria-disabled={anyBusy}
                    >
                      Edit
                    </Link>
                    <Button
                      onClick={() => handleDecision(item.id, "reject")}
                      disabled={anyBusy}
                      variant="outline"
                      className="h-11 gap-2 transition-transform duration-200 active:scale-[0.99] sm:h-9"
                    >
                      {rejectBusy ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : null}
                      Reject
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}

function renderLeadHeader(proposal: LeadProposal) {
  return (
    <>
      <p className="text-base font-medium">
        {proposal.customer_name || "Unknown caller"}
      </p>
      <p className="text-sm tabular-nums text-muted-foreground">
        {proposal.phone}
      </p>
    </>
  )
}

function renderLeadBody(proposal: LeadProposal) {
  return (
    <>
      {proposal.car_info ? (
        <p className="text-sm">{proposal.car_info}</p>
      ) : null}
      {proposal.pin_notes ? (
        <p className="text-sm text-muted-foreground">{proposal.pin_notes}</p>
      ) : null}
    </>
  )
}

function renderNoteHeader(proposal: NoteProposal) {
  const subject =
    proposal.customer_name?.trim() ||
    proposal.phone?.trim() ||
    "General note"
  return (
    <>
      <p className="text-base font-medium">{subject}</p>
      <p className="text-xs text-muted-foreground">From Whisper</p>
    </>
  )
}

function renderNoteBody(proposal: NoteProposal) {
  return (
    <p className="whitespace-pre-line text-sm">{proposal.content}</p>
  )
}

function renderBookingHeader(proposal: BookingProposal) {
  return (
    <>
      <p className="text-base font-medium">
        {proposal.customer_name || "Unknown customer"}
      </p>
      <p className="text-sm tabular-nums text-muted-foreground">
        {proposal.phone}
      </p>
    </>
  )
}

function renderBookingBody(proposal: BookingProposal) {
  return (
    <>
      <p className="text-sm">
        <span className="font-medium">{proposal.service ?? "Service TBD"}</span>{" "}
        — {formatBookingWhen(proposal.iso_start_time, proposal.duration_minutes)}
      </p>
      {proposal.car_info ? (
        <p className="text-sm text-muted-foreground">{proposal.car_info}</p>
      ) : null}
      {proposal.pin_notes ? (
        <p className="text-sm text-muted-foreground">{proposal.pin_notes}</p>
      ) : null}
    </>
  )
}

function renderSmsHeader(proposal: SmsProposal) {
  const target =
    proposal.customer_name?.trim() || proposal.to_phone || "Unknown"
  return (
    <>
      <p className="text-base font-medium">To {target}</p>
      <p className="text-xs text-muted-foreground">
        {proposal.reason ?? "Outbound SMS"}
      </p>
    </>
  )
}

function renderSmsBody(proposal: SmsProposal) {
  return (
    <p className="whitespace-pre-line break-words rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
      {proposal.body}
    </p>
  )
}

function renderChargeHeader(proposal: ChargeProposal) {
  return (
    <>
      <p className="text-base font-medium">
        {proposal.customer_name || "Unknown customer"}{" "}
        <span className="text-muted-foreground">·</span>{" "}
        {formatMoney(proposal.amount_cents)}
      </p>
      <p className="text-xs text-muted-foreground">
        {proposal.customer_email || "Email missing — edit to add"}
      </p>
    </>
  )
}

function renderChargeBody(proposal: ChargeProposal) {
  return (
    <p className="text-sm">
      <span className="font-medium">{proposal.description || "Detailing service"}</span>
    </p>
  )
}

function renderEmailHeader(proposal: EmailProposal) {
  const target =
    proposal.customer_name?.trim() || proposal.to_email || "Unknown"
  return (
    <>
      <p className="text-base font-medium">To {target}</p>
      <p className="truncate text-xs text-muted-foreground">
        {proposal.subject || "(no subject)"}
      </p>
    </>
  )
}

function renderEmailBody(proposal: EmailProposal) {
  const preview = proposal.body.length > 240
    ? `${proposal.body.slice(0, 240).trim()}…`
    : proposal.body
  return (
    <p className="whitespace-pre-line break-words rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
      {preview}
    </p>
  )
}

function renderInstagramHeader(proposal: InstagramDmProposal) {
  const target =
    proposal.customer_name?.trim() ||
    (proposal.recipient_id ? `IG ${proposal.recipient_id}` : "Unknown")
  return (
    <>
      <p className="break-words text-base font-medium">To {target}</p>
      <p className="text-xs text-muted-foreground">
        {proposal.reason ?? "Outbound IG DM"}
      </p>
    </>
  )
}

function renderInstagramBody(proposal: InstagramDmProposal) {
  return (
    <p className="whitespace-pre-line break-words rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
      {proposal.body}
    </p>
  )
}

function renderFacebookHeader(proposal: FacebookDmProposal) {
  const target =
    proposal.customer_name?.trim() ||
    (proposal.recipient_id ? `FB ${proposal.recipient_id}` : "Unknown")
  return (
    <>
      <p className="break-words text-base font-medium">To {target}</p>
      <p className="text-xs text-muted-foreground">
        {proposal.reason ?? "Outbound FB DM"}
      </p>
    </>
  )
}

function renderFacebookBody(proposal: FacebookDmProposal) {
  return (
    <p className="whitespace-pre-line break-words rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
      {proposal.body}
    </p>
  )
}
