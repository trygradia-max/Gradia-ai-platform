"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  Calendar,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  StickyNote,
  User,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  approveFromDashboard,
  rejectFromDashboard,
  undoRejectFromDashboard,
} from "@/app/actions/approvals"
import { STRINGS } from "@/lib/strings"
import { Button, buttonVariants } from "@/components/ui/button"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { SectionHeader } from "@/components/gradia/section-header"
import type {
  LeadStatus,
  PendingActionRow,
  PendingActionType,
} from "@/lib/types/database"
import { cn } from "@/lib/utils"

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

type EmailProposal = {
  to_email: string
  subject: string
  body: string
  customer_name: string | null
  reason: string | null
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

type ActionMeta = {
  icon: LucideIcon
  label: string
  /** Color tone of the icon tile + accent rail. */
  tone: "lead" | "booking" | "outbound" | "money" | "note"
}

const ACTION_META: Record<PendingActionType, ActionMeta> = {
  create_lead: { icon: User, label: "Lead", tone: "lead" },
  add_note: { icon: StickyNote, label: "Note", tone: "note" },
  book_appointment: { icon: Calendar, label: "Booking", tone: "booking" },
  reschedule_appointment: { icon: Calendar, label: "Reschedule", tone: "booking" },
  cancel_appointment: { icon: Calendar, label: "Cancellation", tone: "booking" },
  send_sms: { icon: MessageSquare, label: "SMS", tone: "outbound" },
  send_email: { icon: Mail, label: "Email", tone: "outbound" },
  create_quote: { icon: FileText, label: "Draft quote", tone: "money" },
}

const TONE_STYLE: Record<
  ActionMeta["tone"],
  { tile: string; rail: string; pill: StatusPillTone }
> = {
  lead: {
    tile: "bg-primary/12 text-primary ring-primary/25",
    rail: "before:bg-gradient-to-b before:from-primary/40 before:via-primary/15 before:to-transparent",
    pill: "accent",
  },
  booking: {
    tile: "bg-status-success-bg text-status-success-fg ring-status-success/25",
    rail: "before:bg-gradient-to-b before:from-status-success-fg/40 before:via-status-success-fg/15 before:to-transparent",
    pill: "good",
  },
  outbound: {
    tile: "bg-status-warning-bg text-status-warning-fg ring-status-warning/25",
    rail: "before:bg-gradient-to-b before:from-status-warning-fg/40 before:via-status-warning-fg/15 before:to-transparent",
    pill: "warn",
  },
  money: {
    tile: "bg-status-warning-bg text-status-warning-fg ring-status-warning/25",
    rail: "before:bg-gradient-to-b before:from-status-warning-fg/40 before:via-status-warning-fg/15 before:to-transparent",
    pill: "warn",
  },
  note: {
    tile: "bg-muted text-muted-foreground ring-border/60",
    rail: "",
    pill: "muted",
  },
}

export function ApprovalsList({ items: serverItems }: { items: PendingActionRow[] }) {
  const router = useRouter()
  const reduce = useReducedMotion()
  // Track only what we've optimistically dropped, derived against the server
  // list at render — no effect, no re-seeding. A decided card slides out the
  // instant it's tapped (optimistic, no reload — FOCUS spec §4.4); after the
  // background refresh the server list no longer carries it anyway.
  const [removed, setRemoved] = React.useState<Set<string>>(new Set())
  // Guards a double-tap in the window before the card animates away.
  const inFlight = React.useRef<Set<string>>(new Set())

  const visible = serverItems.filter((i) => !removed.has(i.id))

  if (visible.length === 0) {
    return <EmptyState />
  }

  async function handleDecision(
    id: string,
    decision: "approve" | "reject"
  ): Promise<void> {
    if (inFlight.current.has(id)) return
    if (!serverItems.some((i) => i.id === id)) return
    inFlight.current.add(id)

    // Optimistic: hide the card now; "Sent ✓" is implied by the toast.
    setRemoved((prev) => new Set(prev).add(id))

    const rollback = () => {
      setRemoved((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      inFlight.current.delete(id)
    }

    let result: Awaited<ReturnType<typeof approveFromDashboard>>
    try {
      result =
        decision === "approve"
          ? await approveFromDashboard(id)
          : await rejectFromDashboard(id)
    } catch {
      // Network-level failure (the action never reached the server, or the
      // response never came back): un-hide the card, say so out loud.
      // Silent failure is forbidden.
      rollback()
      toast.error(STRINGS.toasts.decisionFailed)
      return
    }

    if (!result.ok) {
      // Reconcile failure — un-hide the card so the owner can retry.
      rollback()
      toast.error(result.error)
      return
    }

    if (result.alreadyDecided) {
      toast.message(STRINGS.toasts.alreadyDecided)
    } else if (decision === "approve") {
      // Approve executed a real send — irreversible, so no undo offered.
      toast.success(STRINGS.toasts.approvalSent)
    } else {
      // Drop is reversible: undo restores the card to the queue.
      toast.success(STRINGS.toasts.approvalDropped, {
        action: {
          label: STRINGS.actions.undo,
          onClick: () => {
            void (async () => {
              let undo: Awaited<ReturnType<typeof undoRejectFromDashboard>>
              try {
                undo = await undoRejectFromDashboard(id)
              } catch {
                toast.error(STRINGS.toasts.couldntSave)
                return
              }
              if (!undo.ok) {
                toast.error(undo.error)
                return
              }
              setRemoved((prev) => {
                const next = new Set(prev)
                next.delete(id)
                return next
              })
              toast.success(STRINGS.toasts.approvalRestored)
              router.refresh()
            })()
          },
        },
      })
    }

    // Background reconcile: refresh the badge + any server-derived state. The
    // card is already gone, so this never blocks the interaction.
    inFlight.current.delete(id)
    router.refresh()
  }

  return (
    <PageStagger className="grid gap-3">
      <AnimatePresence initial={false}>
        {visible.map((item) => {
          const meta = ACTION_META[item.action_type]
          const isEditRequested = item.status === "edit_requested"

          return (
            <motion.div
              key={item.id}
              layout={!reduce}
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, x: 24, transition: { duration: 0.15 } }
              }
            >
              <StaggerItem>
                <ApprovalCard
                  item={item}
                  meta={meta}
                  isEditRequested={isEditRequested}
                  approveBusy={false}
                  rejectBusy={false}
                  anyBusy={false}
                  onDecision={handleDecision}
                />
              </StaggerItem>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </PageStagger>
  )
}

function ApprovalCard({
  item,
  meta,
  isEditRequested,
  approveBusy,
  rejectBusy,
  anyBusy,
  onDecision,
}: {
  item: PendingActionRow
  meta: ActionMeta
  isEditRequested: boolean
  approveBusy: boolean
  rejectBusy: boolean
  anyBusy: boolean
  onDecision: (id: string, decision: "approve" | "reject") => void
}) {
  const Icon = meta.icon
  const tone = TONE_STYLE[meta.tone]

  return (
    <MotionCard
      interactive={false}
      className={cn(
        "relative overflow-hidden p-5 sm:p-6",
        // Accent rail on the left edge, color-coded to the action type.
        // Notes get no rail (low stakes); everything else does.
        tone.rail &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']",
        tone.rail
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
              tone.tile
            )}
          >
            <Icon className="size-[18px]" aria-hidden />
          </div>
          <div className="min-w-0 space-y-0.5">
            <p className="label-eyebrow text-muted-foreground/70">
              {meta.label}
            </p>
            <div className="font-display text-lg leading-tight tracking-tight text-foreground">
              <ActionHeader item={item} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={isEditRequested ? "warn" : tone.pill}>
            {isEditRequested ? "Edit needed" : "Pending"}
          </StatusPill>
        </div>
      </header>

      <div className="space-y-3 pl-[52px] sm:pl-[52px]">
        <ActionBody item={item} />
        <p className="text-xs text-muted-foreground/80">
          Caught {formatRelative(item.created_at)}
        </p>
      </div>

      {/* Equal visual weight on all three (founder decision + pack
          guardrail: no false hierarchy on the decline). */}
      <div className="mt-5 flex flex-col gap-2 pl-0 sm:flex-row sm:items-center sm:pl-[52px]">
        <Button
          onClick={() => onDecision(item.id, "approve")}
          disabled={anyBusy}
          variant="outline"
          className="h-11 gap-2 transition-transform duration-(--duration-fast) active:scale-[0.98] sm:h-10 sm:px-5"
        >
          {approveBusy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {ACTION_CTA[item.action_type] ?? "Send it"}
        </Button>
        <div className="grid grid-cols-2 gap-2 sm:contents">
          <Link
            href={`/approvals/${item.id}`}
            aria-disabled={anyBusy}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-11 gap-2 sm:h-10"
            )}
          >
            <Pencil className="size-4" aria-hidden />
            Tweak it
          </Link>
          <Button
            onClick={() => onDecision(item.id, "reject")}
            disabled={anyBusy}
            variant="outline"
            className="h-11 gap-2 transition-colors duration-(--duration-fast) hover:text-status-danger-fg sm:h-10"
          >
            {rejectBusy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            Drop it
          </Button>
        </div>
      </div>
    </MotionCard>
  )
}

const ACTION_CTA: Partial<Record<PendingActionType, string>> = {
  send_sms: "Send it",
  send_email: "Send it",
  book_appointment: "Book it",
  create_lead: "Save the lead",
  add_note: "Save the note",
}

function EmptyState() {
  return (
    <MotionCard
      interactive={false}
      className="overflow-hidden px-6 py-16 text-center"
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="space-y-2"
      >
        <p className="font-display text-2xl text-foreground">
          {STRINGS.pages.approvals.titleAllClear}.
        </p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {STRINGS.empty.approvalsEmpty}
        </p>
      </motion.div>
    </MotionCard>
  )
}

// --- per-action renderers ---------------------------------------------------

function ActionHeader({ item }: { item: PendingActionRow }) {
  switch (item.action_type) {
    case "add_note":
      return <NoteHeader proposal={item.payload as unknown as NoteProposal} />
    case "book_appointment":
      return (
        <BookingHeader
          proposal={item.payload as unknown as BookingProposal}
        />
      )
    case "send_sms":
      return <SmsHeader proposal={item.payload as unknown as SmsProposal} />
    case "send_email":
      return (
        <EmailHeader proposal={item.payload as unknown as EmailProposal} />
      )
    case "create_lead":
    default:
      return <LeadHeader proposal={item.payload as unknown as LeadProposal} />
  }
}

function ActionBody({ item }: { item: PendingActionRow }) {
  switch (item.action_type) {
    case "add_note":
      return <NoteBody proposal={item.payload as unknown as NoteProposal} />
    case "book_appointment":
      return (
        <BookingBody proposal={item.payload as unknown as BookingProposal} />
      )
    case "send_sms":
      return <SmsBody proposal={item.payload as unknown as SmsProposal} />
    case "send_email":
      return <EmailBody proposal={item.payload as unknown as EmailProposal} />
    case "create_lead":
    default:
      return <LeadBody proposal={item.payload as unknown as LeadProposal} />
  }
}

function LeadHeader({ proposal }: { proposal: LeadProposal }) {
  return (
    <span>
      {proposal.customer_name || "Unknown caller"}
      {proposal.phone ? (
        <span className="ml-2 align-middle text-sm font-normal tabular-nums text-muted-foreground">
          {proposal.phone}
        </span>
      ) : null}
    </span>
  )
}

function LeadBody({ proposal }: { proposal: LeadProposal }) {
  return (
    <>
      {proposal.car_info ? (
        <p className="text-sm text-foreground/90">{proposal.car_info}</p>
      ) : null}
      {proposal.pin_notes ? (
        <p className="text-sm text-muted-foreground">{proposal.pin_notes}</p>
      ) : null}
    </>
  )
}

function NoteHeader({ proposal }: { proposal: NoteProposal }) {
  const subject =
    proposal.customer_name?.trim() ||
    proposal.phone?.trim() ||
    "General note"
  return (
    <span>
      {subject}
      <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
        from Whisper
      </span>
    </span>
  )
}

function NoteBody({ proposal }: { proposal: NoteProposal }) {
  return (
    <p className="whitespace-pre-line text-sm text-foreground/90">
      {proposal.content}
    </p>
  )
}

function BookingHeader({ proposal }: { proposal: BookingProposal }) {
  return (
    <span>
      {proposal.customer_name || "Unknown customer"}
      {proposal.phone ? (
        <span className="ml-2 align-middle text-sm font-normal tabular-nums text-muted-foreground">
          {proposal.phone}
        </span>
      ) : null}
    </span>
  )
}

function BookingBody({ proposal }: { proposal: BookingProposal }) {
  return (
    <>
      <p className="text-sm text-foreground/90">
        <span className="font-medium text-foreground">
          {proposal.service ?? "Service TBD"}
        </span>{" "}
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

function SmsHeader({ proposal }: { proposal: SmsProposal }) {
  const target =
    proposal.customer_name?.trim() || proposal.to_phone || "Unknown"
  return (
    <span>
      To {target}
      {proposal.reason ? (
        <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
          {proposal.reason}
        </span>
      ) : null}
    </span>
  )
}

/** Cross-model verifier objection (sharpening brief P1) — the draft was
 *  staged anyway, flagged so the approver knows what smells off. */
function VerifierFlag({ proposal }: { proposal: Record<string, unknown> }) {
  const verifier = proposal.verifier as
    | { flagged?: boolean; objections?: string[] }
    | undefined
  if (!verifier?.flagged) return null
  return (
    <p className="mt-1.5 rounded-md border border-status-warning/25 bg-status-warning-bg px-2 py-1.5 text-xs text-status-warning-fg">
      ⚠ Our reviewer flagged this draft:{" "}
      {(verifier.objections ?? []).join(" ") || "double-check before sending."}
    </p>
  )
}

function SmsBody({ proposal }: { proposal: SmsProposal }) {
  return (
    <>
      <MessagePreview body={proposal.body} />
      <VerifierFlag proposal={proposal as unknown as Record<string, unknown>} />
    </>
  )
}

function EmailHeader({ proposal }: { proposal: EmailProposal }) {
  const target =
    proposal.customer_name?.trim() || proposal.to_email || "Unknown"
  return (
    <span>
      To {target}
      <span className="ml-2 align-middle truncate text-xs font-normal text-muted-foreground">
        {proposal.subject || "(no subject)"}
      </span>
    </span>
  )
}

function EmailBody({ proposal }: { proposal: EmailProposal }) {
  const preview =
    proposal.body.length > 240
      ? `${proposal.body.slice(0, 240).trim()}…`
      : proposal.body
  return (
    <>
      <MessagePreview body={preview} />
      <VerifierFlag proposal={proposal as unknown as Record<string, unknown>} />
    </>
  )
}

function MessagePreview({ body }: { body: string }) {
  return (
    <p className="relative whitespace-pre-line break-words rounded-lg border border-border/60 bg-muted/20 px-3.5 py-2.5 text-sm text-foreground/90">
      {body}
    </p>
  )
}

// Re-export SectionHeader so its import isn't unused if a parent wants
// to slot one above this list. (Kept inline-importable for the page.)
export { SectionHeader }
