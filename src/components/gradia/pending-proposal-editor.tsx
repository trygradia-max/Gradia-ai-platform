"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  approveWithEdits,
  rejectFromDashboard,
  updatePendingProposal,
  type ProposalPatch,
} from "@/app/actions/approvals"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { LeadStatus } from "@/lib/types/database"

type LeadInitial = {
  type: "create_lead"
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
}

type NoteInitial = {
  type: "add_note"
  content: string
  customer_name: string | null
  phone: string | null
}

type BookingInitial = {
  type: "book_appointment"
  customer_name: string
  phone: string
  car_info: string | null
  service: string | null
  iso_start_time: string
  duration_minutes: number
  timezone: string | null
  pin_notes: string | null
}

type SmsInitial = {
  type: "send_sms"
  to_phone: string
  body: string
  customer_name: string | null
  reason: string | null
}

type ChargeInitial = {
  type: "charge_customer"
  customer_name: string
  customer_email: string
  amount_cents: number
  description: string
}

type EmailInitial = {
  type: "send_email"
  to_email: string
  subject: string
  body: string
  customer_name: string | null
  reason: string | null
}

type InstagramDmInitial = {
  type: "send_instagram_dm"
  recipient_id: string
  body: string
  customer_name: string | null
  reason: string | null
}

export type PendingProposalEditorProps = {
  pendingId: string
  source: string | null
  submittedAt: string
  status: "pending" | "edit_requested"
  initial:
    | LeadInitial
    | NoteInitial
    | BookingInitial
    | SmsInitial
    | ChargeInitial
    | EmailInitial
    | InstagramDmInitial
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

function fromLocalInputValue(local: string): string {
  if (!local) return ""
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return ""
  return d.toISOString()
}

export function PendingProposalEditor(props: PendingProposalEditorProps) {
  const router = useRouter()
  const [pending, setPending] = React.useState<
    null | "save" | "approve" | "discard"
  >(null)

  const kind = props.initial.type
  const leadInit =
    kind === "create_lead" ? (props.initial as LeadInitial) : null
  const bookingInit =
    kind === "book_appointment" ? (props.initial as BookingInitial) : null
  const noteInit = kind === "add_note" ? (props.initial as NoteInitial) : null
  const smsInit = kind === "send_sms" ? (props.initial as SmsInitial) : null
  const chargeInit =
    kind === "charge_customer" ? (props.initial as ChargeInitial) : null
  const emailInit =
    kind === "send_email" ? (props.initial as EmailInitial) : null
  const igInit =
    kind === "send_instagram_dm"
      ? (props.initial as InstagramDmInitial)
      : null

  const [customerName, setCustomerName] = React.useState(
    leadInit?.customer_name ??
      bookingInit?.customer_name ??
      smsInit?.customer_name ??
      chargeInit?.customer_name ??
      emailInit?.customer_name ??
      igInit?.customer_name ??
      noteInit?.customer_name ??
      ""
  )
  const [emailTo, setEmailTo] = React.useState(emailInit?.to_email ?? "")
  const [emailSubject, setEmailSubject] = React.useState(
    emailInit?.subject ?? ""
  )
  const [emailBody, setEmailBody] = React.useState(emailInit?.body ?? "")
  const [emailReason, setEmailReason] = React.useState(emailInit?.reason ?? "")
  const [igRecipient, setIgRecipient] = React.useState(
    igInit?.recipient_id ?? ""
  )
  const [igBody, setIgBody] = React.useState(igInit?.body ?? "")
  const [igReason, setIgReason] = React.useState(igInit?.reason ?? "")
  const [chargeEmail, setChargeEmail] = React.useState(
    chargeInit?.customer_email ?? ""
  )
  const [chargeAmountDollars, setChargeAmountDollars] = React.useState(
    chargeInit ? (chargeInit.amount_cents / 100).toFixed(2) : ""
  )
  const [chargeDescription, setChargeDescription] = React.useState(
    chargeInit?.description ?? ""
  )
  const [phone, setPhone] = React.useState(
    leadInit?.phone ?? bookingInit?.phone ?? noteInit?.phone ?? ""
  )
  const [smsBody, setSmsBody] = React.useState(smsInit?.body ?? "")
  const [smsToPhone, setSmsToPhone] = React.useState(smsInit?.to_phone ?? "")
  const [smsReason, setSmsReason] = React.useState(smsInit?.reason ?? "")
  const [carInfo, setCarInfo] = React.useState(
    leadInit?.car_info ?? bookingInit?.car_info ?? ""
  )
  const [pinNotes, setPinNotes] = React.useState(
    leadInit?.pin_notes ?? bookingInit?.pin_notes ?? ""
  )
  const [leadStatus, setLeadStatus] = React.useState<LeadStatus>(
    leadInit?.status ?? "new"
  )
  const [noteContent, setNoteContent] = React.useState(noteInit?.content ?? "")
  const [service, setService] = React.useState(bookingInit?.service ?? "")
  const [startLocal, setStartLocal] = React.useState(
    bookingInit ? toLocalInputValue(bookingInit.iso_start_time) : ""
  )
  const [durationMinutes, setDurationMinutes] = React.useState(
    bookingInit?.duration_minutes ?? 90
  )

  function buildPatch(): ProposalPatch {
    if (kind === "create_lead") {
      return {
        type: "create_lead",
        customer_name: customerName,
        phone,
        car_info: carInfo.trim() ? carInfo : null,
        pin_notes: pinNotes.trim() ? pinNotes : null,
        status: leadStatus,
      }
    }
    if (kind === "book_appointment") {
      return {
        type: "book_appointment",
        customer_name: customerName,
        phone,
        car_info: carInfo.trim() ? carInfo : null,
        service: service.trim() ? service : null,
        iso_start_time: fromLocalInputValue(startLocal),
        duration_minutes: durationMinutes,
        timezone: bookingInit?.timezone ?? null,
        pin_notes: pinNotes.trim() ? pinNotes : null,
      }
    }
    if (kind === "send_sms") {
      return {
        type: "send_sms",
        to_phone: smsToPhone.trim(),
        body: smsBody,
        customer_name: customerName.trim() ? customerName : null,
        reason: smsReason.trim() ? smsReason : null,
      }
    }
    if (kind === "charge_customer") {
      const dollars = Number.parseFloat(chargeAmountDollars)
      const amountCents = Number.isFinite(dollars)
        ? Math.round(dollars * 100)
        : 0
      return {
        type: "charge_customer",
        customer_name: customerName,
        customer_email: chargeEmail.trim(),
        amount_cents: amountCents,
        description: chargeDescription,
      }
    }
    if (kind === "send_email") {
      return {
        type: "send_email",
        to_email: emailTo.trim(),
        subject: emailSubject,
        body: emailBody,
        customer_name: customerName.trim() ? customerName : null,
        reason: emailReason.trim() ? emailReason : null,
      }
    }
    if (kind === "send_instagram_dm") {
      return {
        type: "send_instagram_dm",
        recipient_id: igRecipient.trim(),
        body: igBody,
        customer_name: customerName.trim() ? customerName : null,
        reason: igReason.trim() ? igReason : null,
      }
    }
    return {
      type: "add_note",
      content: noteContent,
      customer_name: customerName.trim() ? customerName : null,
      phone: phone.trim() ? phone : null,
    }
  }

  async function handleSave() {
    setPending("save")
    const result = await updatePendingProposal(props.pendingId, buildPatch())
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (result.alreadyDecided) {
      toast.message("Already decided elsewhere — refreshing.")
      router.replace("/approvals")
      return
    }
    toast.success("Changes saved.")
    router.refresh()
  }

  async function handleApprove() {
    setPending("approve")
    const result = await approveWithEdits(props.pendingId, buildPatch())
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.alreadyDecided ? "Already decided." : "Approved and saved.")
    router.replace("/approvals")
  }

  async function handleDiscard() {
    if (!confirm("Drop this proposal? It won't be saved anywhere.")) return
    setPending("discard")
    const result = await rejectFromDashboard(props.pendingId)
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Dropped.")
    router.replace("/approvals")
  }

  const anyPending = pending !== null

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base font-medium">
            {kind === "create_lead"
              ? "Edit lead proposal"
              : kind === "book_appointment"
                ? "Edit booking request"
                : kind === "send_sms"
                  ? "Edit SMS draft"
                  : kind === "charge_customer"
                    ? "Edit charge"
                    : kind === "send_email"
                      ? "Edit email draft"
                      : kind === "send_instagram_dm"
                        ? "Edit IG DM draft"
                        : "Edit note proposal"}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Source: {props.source ?? "unknown"} ·{" "}
            {props.status === "edit_requested"
              ? "edits requested"
              : "awaiting our review"}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {kind === "create_lead" ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="customer-name">Customer name</Label>
              <Input
                id="customer-name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. Sam Rivera"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 555-123-4567"
                  autoComplete="off"
                  inputMode="tel"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={leadStatus}
                  onValueChange={(v) => setLeadStatus(v as LeadStatus)}
                >
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="quoted">Quoted</SelectItem>
                    <SelectItem value="booked">Booked</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="car-info">Vehicle</Label>
              <Input
                id="car-info"
                value={carInfo}
                onChange={(e) => setCarInfo(e.target.value)}
                placeholder="e.g. 2023 Tesla Model Y, blue"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pin-notes">Notes</Label>
              <Textarea
                id="pin-notes"
                value={pinNotes}
                onChange={(e) => setPinNotes(e.target.value)}
                placeholder="Anything else worth flagging for the next touchpoint."
                rows={4}
              />
            </div>
          </>
        ) : kind === "book_appointment" ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="customer-name">Customer name</Label>
              <Input
                id="customer-name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. Sam Rivera"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 555-123-4567"
                  autoComplete="off"
                  inputMode="tel"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="service">Service</Label>
                <Input
                  id="service"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  placeholder="e.g. Ceramic coating"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
              <div className="grid gap-2">
                <Label htmlFor="start-time">Start</Label>
                <Input
                  id="start-time"
                  type="datetime-local"
                  value={startLocal}
                  onChange={(e) => setStartLocal(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="duration">Duration (min)</Label>
                <Input
                  id="duration"
                  type="number"
                  min={15}
                  step={15}
                  value={durationMinutes}
                  onChange={(e) =>
                    setDurationMinutes(
                      Math.max(15, Number.parseInt(e.target.value, 10) || 0)
                    )
                  }
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="car-info">Vehicle</Label>
              <Input
                id="car-info"
                value={carInfo}
                onChange={(e) => setCarInfo(e.target.value)}
                placeholder="e.g. 2023 Tesla Model Y, blue"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pin-notes">Notes</Label>
              <Textarea
                id="pin-notes"
                value={pinNotes}
                onChange={(e) => setPinNotes(e.target.value)}
                placeholder="Anything else worth flagging."
                rows={3}
              />
            </div>
          </>
        ) : kind === "send_sms" ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="sms-to">To</Label>
                <Input
                  id="sms-to"
                  value={smsToPhone}
                  onChange={(e) => setSmsToPhone(e.target.value)}
                  placeholder="+15551234567"
                  autoComplete="off"
                  inputMode="tel"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="customer-name">Customer (optional)</Label>
                <Input
                  id="customer-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Sam Rivera"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sms-body">Message</Label>
              <Textarea
                id="sms-body"
                value={smsBody}
                onChange={(e) => setSmsBody(e.target.value)}
                placeholder="Hey Sam — we've got you down for Saturday at 2pm. We'll text again the morning of."
                rows={5}
              />
              <p className="text-xs text-muted-foreground">
                {smsBody.length} / 1600 characters
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sms-reason">Why we&apos;re sending</Label>
              <Input
                id="sms-reason"
                value={smsReason}
                onChange={(e) => setSmsReason(e.target.value)}
                placeholder="e.g. Booking confirmation"
                autoComplete="off"
              />
            </div>
          </>
        ) : kind === "charge_customer" ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="customer-name">Customer name</Label>
                <Input
                  id="customer-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Sam Rivera"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="charge-email">Email</Label>
                <Input
                  id="charge-email"
                  value={chargeEmail}
                  onChange={(e) => setChargeEmail(e.target.value)}
                  placeholder="sam@example.com"
                  autoComplete="off"
                  inputMode="email"
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="charge-amount">Amount (USD)</Label>
                <Input
                  id="charge-amount"
                  value={chargeAmountDollars}
                  onChange={(e) => setChargeAmountDollars(e.target.value)}
                  placeholder="450.00"
                  inputMode="decimal"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="charge-description">What for</Label>
                <Input
                  id="charge-description"
                  value={chargeDescription}
                  onChange={(e) => setChargeDescription(e.target.value)}
                  placeholder="e.g. Ceramic coating"
                  autoComplete="off"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              On approve, Stripe creates an invoice on our connected
              account and emails the customer a hosted-payment link. No
              card on file required.
            </p>
          </>
        ) : kind === "send_email" ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="email-to">To</Label>
                <Input
                  id="email-to"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="sam@example.com"
                  autoComplete="off"
                  inputMode="email"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="customer-name">Customer (optional)</Label>
                <Input
                  id="customer-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Sam Rivera"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-subject">Subject</Label>
              <Input
                id="email-subject"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Re: Ceramic coating quote"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-body">Body</Label>
              <Textarea
                id="email-body"
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                placeholder="Hey Sam — thanks for reaching out about ceramic coating..."
                rows={9}
              />
              <p className="text-xs text-muted-foreground">
                Plain text. Send as plain text from the shop&apos;s
                connected mailbox.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-reason">Why we&apos;re sending</Label>
              <Input
                id="email-reason"
                value={emailReason}
                onChange={(e) => setEmailReason(e.target.value)}
                placeholder="e.g. Reply to inquiry about ceramic"
                autoComplete="off"
              />
            </div>
          </>
        ) : kind === "send_instagram_dm" ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="ig-recipient">IG recipient ID</Label>
                <Input
                  id="ig-recipient"
                  value={igRecipient}
                  onChange={(e) => setIgRecipient(e.target.value)}
                  placeholder="Page-scoped sender id"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="customer-name">Customer (optional)</Label>
                <Input
                  id="customer-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Sam Rivera"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ig-body">Message</Label>
              <Textarea
                id="ig-body"
                value={igBody}
                onChange={(e) => setIgBody(e.target.value)}
                placeholder="Hey — thanks for reaching out…"
                rows={5}
              />
              <p className="text-xs text-muted-foreground">
                {igBody.length} / 900 characters
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ig-reason">Why we&apos;re sending</Label>
              <Input
                id="ig-reason"
                value={igReason}
                onChange={(e) => setIgReason(e.target.value)}
                placeholder="e.g. Reply to ceramic inquiry"
                autoComplete="off"
              />
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="note-content">Note</Label>
              <Textarea
                id="note-content"
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                rows={6}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="customer-name">About (name)</Label>
                <Input
                  id="customer-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Optional"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Optional"
                  autoComplete="off"
                  inputMode="tel"
                />
              </div>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <Button
            type="button"
            variant="destructive"
            onClick={handleDiscard}
            disabled={anyPending}
            className="gap-2"
          >
            {pending === "discard" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
            Discard
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/approvals"
              className={buttonVariants({ variant: "ghost" })}
              aria-disabled={anyPending}
            >
              Cancel
            </Link>
            <Button
              type="button"
              variant="outline"
              onClick={handleSave}
              disabled={anyPending}
              className="gap-2"
            >
              {pending === "save" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Save
            </Button>
            <Button
              type="button"
              onClick={handleApprove}
              disabled={anyPending}
              className="gap-2"
            >
              {pending === "approve" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Check className="size-4" aria-hidden />
              )}
              Save &amp; approve
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Caught {formatRelative(props.submittedAt)}
        </p>
      </CardContent>
    </Card>
  )
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
