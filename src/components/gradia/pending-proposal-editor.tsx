"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Calendar,
  Check,
  Loader2,
  Mail,
  MessageSquare,
  StickyNote,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  approveWithEdits,
  rejectFromDashboard,
  updatePendingProposal,
  type ProposalPatch,
} from "@/app/actions/approvals"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { Button, buttonVariants } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
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
import { cn } from "@/lib/utils"

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

type EmailInitial = {
  type: "send_email"
  to_email: string
  subject: string
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
    | EmailInitial
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

type ProposalKind =
  | "create_lead"
  | "add_note"
  | "book_appointment"
  | "send_sms"
  | "send_email"

type EditorMeta = {
  icon: LucideIcon
  eyebrow: string
  title: string
  /** What the approve button reads as for this action type. */
  approveCta: string
  tone: "lead" | "booking" | "outbound" | "money" | "note"
}

const EDITOR_META: Record<ProposalKind, EditorMeta> = {
  create_lead: {
    icon: User,
    eyebrow: "Lead",
    title: "Tweak the lead",
    approveCta: "Save the lead",
    tone: "lead",
  },
  add_note: {
    icon: StickyNote,
    eyebrow: "Note",
    title: "Tweak the note",
    approveCta: "Save the note",
    tone: "note",
  },
  book_appointment: {
    icon: Calendar,
    eyebrow: "Booking",
    title: "Tweak the booking",
    approveCta: "Book it",
    tone: "booking",
  },
  send_sms: {
    icon: MessageSquare,
    eyebrow: "SMS",
    title: "Tweak the text",
    approveCta: "Send the text",
    tone: "outbound",
  },
  send_email: {
    icon: Mail,
    eyebrow: "Email",
    title: "Tweak the email",
    approveCta: "Send the email",
    tone: "outbound",
  },
}

const TONE_STYLE: Record<
  EditorMeta["tone"],
  { tile: string; rail: string }
> = {
  lead: {
    tile: "bg-primary/12 text-primary ring-primary/25",
    rail: "before:bg-gradient-to-b before:from-primary/40 before:via-primary/15 before:to-transparent",
  },
  booking: {
    tile: "bg-status-success-bg text-status-success-fg ring-status-success/25",
    rail: "before:bg-gradient-to-b before:from-status-success-fg/40 before:via-status-success-fg/15 before:to-transparent",
  },
  outbound: {
    tile: "bg-status-warning-bg text-status-warning-fg ring-status-warning/25",
    rail: "before:bg-gradient-to-b before:from-status-warning-fg/40 before:via-status-warning-fg/15 before:to-transparent",
  },
  money: {
    tile: "bg-status-warning-bg text-status-warning-fg ring-status-warning/25",
    rail: "before:bg-gradient-to-b before:from-status-warning-fg/40 before:via-status-warning-fg/15 before:to-transparent",
  },
  note: {
    tile: "bg-muted text-muted-foreground ring-border/60",
    rail: "",
  },
}

export function PendingProposalEditor(props: PendingProposalEditorProps) {
  const router = useRouter()
  const { confirm, dialog: confirmDialog } = useConfirm()
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
  const emailInit =
    kind === "send_email" ? (props.initial as EmailInitial) : null

  const [customerName, setCustomerName] = React.useState(
    leadInit?.customer_name ??
      bookingInit?.customer_name ??
      smsInit?.customer_name ??
      emailInit?.customer_name ??
      noteInit?.customer_name ??
      ""
  )
  const [emailTo, setEmailTo] = React.useState(emailInit?.to_email ?? "")
  const [emailSubject, setEmailSubject] = React.useState(
    emailInit?.subject ?? ""
  )
  const [emailBody, setEmailBody] = React.useState(emailInit?.body ?? "")
  const [emailReason, setEmailReason] = React.useState(emailInit?.reason ?? "")
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
    const ok = await confirm({
      title: "Drop this proposal?",
      description: "We won't save it anywhere — close the loop or edit it first if there's anything worth keeping.",
      confirmLabel: "Drop it",
      tone: "destructive",
    })
    if (!ok) return
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
  const meta = EDITOR_META[kind as ProposalKind]
  const tone = TONE_STYLE[meta.tone]
  const Icon = meta.icon

  return (
    <MotionCard
      interactive={false}
      className={cn(
        "relative overflow-hidden p-5 sm:p-6",
        // Tone-coded accent rail down the left edge — matches the
        // approvals list card's color language so the operator carries
        // the same context from list → edit.
        tone.rail &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']",
        tone.rail
      )}
    >
      {confirmDialog}

      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
              tone.tile
            )}
          >
            <Icon className="size-[18px]" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">
              {meta.eyebrow}
            </p>
            <h2 className="font-display text-xl leading-tight tracking-tight text-foreground">
              {meta.title}
            </h2>
            <p className="text-xs text-muted-foreground">
              {props.source ? (
                <>
                  Caught via{" "}
                  <span className="text-foreground/80">{props.source}</span>
                </>
              ) : (
                "Caught from inside the shop"
              )}
              <span className="text-muted-foreground/60"> · </span>
              {props.status === "edit_requested"
                ? "edits requested"
                : "awaiting your yes"}
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-5">
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

        <div className="mt-2 flex flex-col gap-2 border-t border-border/40 pt-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
          {/* Primary action first on mobile so it lands under the
              thumb without scrolling past secondary actions. */}
          <Button
            type="button"
            onClick={handleApprove}
            disabled={anyPending}
            size="lg"
            className="order-1 h-11 gap-2 transition-transform duration-(--duration-fast) active:scale-[0.98] sm:order-3 sm:h-10 sm:px-5"
          >
            {pending === "approve" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            Save &amp; {meta.approveCta.toLowerCase()}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleSave}
            disabled={anyPending}
            className="order-2 h-11 gap-2 sm:order-2 sm:h-10"
          >
            {pending === "save" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            Save the edits
          </Button>
          <div className="order-3 grid grid-cols-2 gap-2 sm:order-1 sm:flex sm:items-center sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={handleDiscard}
              disabled={anyPending}
              className="h-11 gap-2 text-muted-foreground transition-colors duration-(--duration-fast) hover:text-destructive sm:h-10"
            >
              {pending === "discard" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="size-4" aria-hidden />
              )}
              Drop it
            </Button>
            <Link
              href="/approvals"
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "h-11 sm:h-10"
              )}
              aria-disabled={anyPending}
            >
              Back
            </Link>
          </div>
        </div>
        <p className="pt-1 text-xs text-muted-foreground">
          Caught {formatRelative(props.submittedAt)}
        </p>
      </div>
    </MotionCard>
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
