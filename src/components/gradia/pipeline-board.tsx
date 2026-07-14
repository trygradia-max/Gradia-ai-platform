"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  FileUp,
  LayoutGrid,
  Loader2,
  Mail,
  MessageSquare,
  Mic,
  Pencil,
  Phone,
  Plus,
  Rows3,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import {
  addLeadNote,
  getLeadDetail,
  quickCreateLead,
  setLeadStage,
  type LeadDetail,
} from "@/app/actions/pipeline"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { LOST_REASONS, PIPELINE_STAGES, type LostReason } from "@/lib/pipeline"
import { formatPriceUsd } from "@/lib/service-pricing"
import type { PipelineCard, PipelineData } from "@/lib/data/pipeline"
import type { CrmStage } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/**
 * Pipeline kanban (CRM C2). Drag on desktop, Stage button on mobile — both
 * write stage_history through the same action. Stage colors are dots +
 * labels (status is never color alone). Lost always asks for a reason.
 */

const STAGE_DOT: Record<CrmStage, string> = {
  new: "bg-status-info-fg",
  needs_quote: "bg-status-warning-fg",
  quote_sent: "bg-primary",
  follow_up: "bg-status-warning-fg",
  booked: "bg-status-success-fg",
  lost: "bg-status-danger-fg",
}

/** Written empty states per column — first-use teaches, never blank. */
const STAGE_EMPTY_COPY: Record<CrmStage, string> = {
  new: "New calls and texts land here on their own.",
  needs_quote: "Drag a card here when they want a price.",
  quote_sent: "Cards arrive here when a quote goes out.",
  follow_up: "Quiet quotes surface here after two days.",
  booked: "Approved bookings land here.",
  lost: "Drag here to close one out — we'll ask why.",
}

const LOST_REASON_LABELS: Record<LostReason, string> = {
  price: "Price",
  timing: "Timing",
  no_response: "No response",
  competitor: "Went elsewhere",
  other: "Other",
}

function renderSourceIcon(source: string | null): React.ReactNode {
  const cls = "size-3 shrink-0 text-muted-foreground/70"
  switch (source) {
    case "voice":
      return <Mic className={cls} aria-hidden />
    case "sms":
      return <MessageSquare className={cls} aria-hidden />
    case "email":
      return <Mail className={cls} aria-hidden />
    case "import":
      return <FileUp className={cls} aria-hidden />
    case "manual":
      return <Pencil className={cls} aria-hidden />
    default:
      return <Phone className={cls} aria-hidden />
  }
}

/** Amber past next_action_at, red past 2× the window. */
function ageTone(card: PipelineCard): "ok" | "amber" | "red" {
  if (!card.nextActionAt || card.stage === "booked" || card.stage === "lost") return "ok"
  const due = Date.parse(card.nextActionAt)
  const entered = card.stageEnteredAt ? Date.parse(card.stageEnteredAt) : due
  const now = Date.now()
  if (now < due) return "ok"
  return now > due + Math.max(due - entered, 60_000) ? "red" : "amber"
}

export function PipelineBoard({ initial }: { initial: PipelineData }) {
  const router = useRouter()
  const [cards, setCards] = React.useState(initial.cards)
  const [view, setView] = React.useState<"board" | "table">("board")
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dropStage, setDropStage] = React.useState<CrmStage | null>(null)
  const [lostPrompt, setLostPrompt] = React.useState<{ leadId: string; back: CrmStage } | null>(null)
  const [newLeadOpen, setNewLeadOpen] = React.useState(false)
  const [detailId, setDetailId] = React.useState<string | null>(null)

  const byStage = (stage: CrmStage) => cards.filter((c) => c.stage === stage)
  const totals = Object.fromEntries(
    PIPELINE_STAGES.map((s) => {
      const items = byStage(s.key)
      return [
        s.key,
        {
          count: items.length,
          valueCents: items.reduce(
            (sum, c) => sum + (c.quoteTotalCents ?? c.estValueCents ?? 0),
            0
          ),
        },
      ]
    })
  ) as PipelineData["totals"]

  async function move(leadId: string, stage: CrmStage, lostReason?: LostReason) {
    const prev = cards
    setCards((cur) => cur.map((c) => (c.id === leadId ? { ...c, stage } : c)))
    const result = await setLeadStage(leadId, stage, lostReason ?? null)
    if (!result.ok) {
      setCards(prev)
      toast.error(result.error)
    }
  }

  function requestMove(leadId: string, stage: CrmStage) {
    const card = cards.find((c) => c.id === leadId)
    if (!card || card.stage === stage) return
    if (stage === "lost") {
      // Explicit Lost requires a reason (spec C2) — dialog collects it.
      setLostPrompt({ leadId, back: card.stage })
      return
    }
    void move(leadId, stage)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
          <button
            type="button"
            onClick={() => setView("board")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              view === "board"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <LayoutGrid className="size-3.5" aria-hidden />
            Board
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              view === "table"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Rows3 className="size-3.5" aria-hidden />
            Table
          </button>
        </div>
        <Button type="button" size="sm" className="gap-1.5" onClick={() => setNewLeadOpen(true)}>
          <Plus className="size-4" aria-hidden />
          New lead
        </Button>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-2xl border border-border/60 bg-card px-6 py-16 text-center">
          <p className="font-display text-xl text-foreground">
            The board fills <span className="italic">itself</span>.
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
            Every call, text, and import lands a card here automatically — or
            add one by hand in about ten seconds.
          </p>
          <Button type="button" size="sm" className="mt-4 gap-1.5" onClick={() => setNewLeadOpen(true)}>
            <Plus className="size-4" aria-hidden />
            New lead
          </Button>
        </div>
      ) : view === "table" ? (
        <PipelineTable cards={cards} onOpen={setDetailId} />
      ) : (
        <>
          {/* Desktop: 6-column kanban with HTML5 drag. */}
          <div className="hidden gap-3 overflow-x-auto pb-2 lg:grid lg:grid-cols-6">
            {PIPELINE_STAGES.map((s) => (
              <div
                key={s.key}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDropStage(s.key)
                }}
                onDragLeave={() => setDropStage((cur) => (cur === s.key ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault()
                  setDropStage(null)
                  const id = e.dataTransfer.getData("text/lead-id") || dragId
                  if (id) requestMove(id, s.key)
                  setDragId(null)
                }}
                className={cn(
                  "flex min-h-64 flex-col rounded-xl border bg-card/40 transition-colors",
                  dropStage === s.key ? "border-primary/50 bg-primary/5" : "border-border/50"
                )}
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className={cn("size-1.5 shrink-0 rounded-full", STAGE_DOT[s.key])} aria-hidden />
                    <span className="truncate">{s.label}</span>
                    {totals[s.key].count > 0 ? (
                      <span className="font-data rounded-full bg-muted/60 px-1.5 py-px text-[10px] text-muted-foreground">
                        {totals[s.key].count}
                      </span>
                    ) : null}
                  </span>
                  {totals[s.key].valueCents > 0 ? (
                    <span className="font-data shrink-0 text-xs font-medium text-foreground">
                      {formatPriceUsd(totals[s.key].valueCents)}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                  {byStage(s.key).length === 0 ? (
                    <p className="px-2 pt-3 text-center text-[11px] leading-relaxed text-muted-foreground/70">
                      {STAGE_EMPTY_COPY[s.key]}
                    </p>
                  ) : null}
                  {byStage(s.key).map((c) => (
                    <CardFace
                      key={c.id}
                      card={c}
                      draggable
                      onDragStart={() => setDragId(c.id)}
                      onOpen={() => setDetailId(c.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Mobile: stage-grouped list with a Stage button instead of drag. */}
          <div className="space-y-6 lg:hidden">
            {PIPELINE_STAGES.map((s) => {
              const items = byStage(s.key)
              if (items.length === 0) return null
              return (
                <section key={s.key} className="space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className={cn("size-1.5 rounded-full", STAGE_DOT[s.key])} aria-hidden />
                    {s.label}
                    <span className="font-data text-muted-foreground">
                      {items.length}
                      {totals[s.key].valueCents > 0
                        ? ` · ${formatPriceUsd(totals[s.key].valueCents)}`
                        : ""}
                    </span>
                  </p>
                  <div className="space-y-2">
                    {items.map((c) => (
                      <CardFace
                        key={c.id}
                        card={c}
                        onOpen={() => setDetailId(c.id)}
                        stagePicker={
                          <Select
                            value={c.stage}
                            onValueChange={(v) => v && requestMove(c.id, v as CrmStage)}
                          >
                            <SelectTrigger
                              className="h-7 w-28 text-xs"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PIPELINE_STAGES.map((st) => (
                                <SelectItem key={st.key} value={st.key}>
                                  {st.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        }
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </>
      )}

      <LostReasonDialog
        open={lostPrompt !== null}
        onCancel={() => setLostPrompt(null)}
        onConfirm={(reason) => {
          if (lostPrompt) void move(lostPrompt.leadId, "lost", reason)
          setLostPrompt(null)
        }}
      />

      <NewLeadDialog
        open={newLeadOpen}
        onClose={() => setNewLeadOpen(false)}
        onCreated={() => {
          setNewLeadOpen(false)
          router.refresh()
        }}
      />

      <LeadSlideOver leadId={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}

function CardFace({
  card,
  draggable = false,
  onDragStart,
  onOpen,
  stagePicker,
}: {
  card: PipelineCard
  draggable?: boolean
  onDragStart?: () => void
  onOpen: () => void
  stagePicker?: React.ReactNode
}) {
  const tone = ageTone(card)
  const amount = card.quoteTotalCents ?? card.estValueCents
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/lead-id", card.id)
        onDragStart?.()
      }}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "rounded-lg border bg-card px-3 py-2.5 text-left transition-colors",
        // Stage-age urgency on the whole card, not just a dot (C2 fix-pass):
        tone === "red"
          ? "border-status-danger-fg/60 hover:border-status-danger-fg"
          : tone === "amber"
            ? "border-status-warning-fg/60 hover:border-status-warning-fg"
            : "border-border/60 hover:border-border",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-foreground">{card.name}</p>
        <span className="flex shrink-0 items-center gap-1">
          {card.hasStagedSuggestion ? (
            <span title="A suggestion is waiting in Approvals">
              <Zap className="size-3.5 text-primary" aria-label="Staged suggestion waiting" />
            </span>
          ) : null}
          {tone !== "ok" ? (
            <span
              className={cn(
                "size-2 rounded-full",
                tone === "red" ? "bg-status-danger-fg" : "bg-status-warning-fg"
              )}
              title={tone === "red" ? "Well past its next action" : "Past its next action"}
            />
          ) : null}
        </span>
      </div>
      {card.vehicle ? (
        <p className="truncate text-xs text-muted-foreground" title={card.vehicle}>
          {card.vehicle}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {renderSourceIcon(card.source)}
          {card.interest ? (
            <span
              className="truncate rounded-full border border-border/50 px-1.5 py-px text-[11px] text-muted-foreground"
              title={card.interest}
            >
              {card.interest.length > 26 ? `${card.interest.slice(0, 26)}…` : card.interest}
            </span>
          ) : null}
        </span>
        {amount ? (
          <span className="font-data shrink-0 text-xs text-foreground">
            {formatPriceUsd(amount)}
          </span>
        ) : null}
      </div>
      {stagePicker ? <div className="mt-2">{stagePicker}</div> : null}
    </div>
  )
}

function PipelineTable({
  cards,
  onOpen,
}: {
  cards: PipelineCard[]
  onOpen: (id: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">Vehicle</th>
            <th className="px-3 py-2 font-medium">Quote</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Added</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr
              key={c.id}
              onClick={() => onOpen(c.id)}
              className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-muted/30"
            >
              <td className="px-3 py-2 font-medium text-foreground">{c.name}</td>
              <td className="px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn("size-1.5 rounded-full", STAGE_DOT[c.stage])} aria-hidden />
                  {PIPELINE_STAGES.find((s) => s.key === c.stage)?.label}
                </span>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{c.vehicle ?? "—"}</td>
              <td className="font-data px-3 py-2 text-foreground">
                {c.quoteTotalCents ? formatPriceUsd(c.quoteTotalCents) : "—"}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{c.source ?? "—"}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {new Date(c.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LostReasonDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: (reason: LostReason) => void
}) {
  const [reason, setReason] = React.useState<LostReason>("no_response")
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Why did we lose this one?</DialogTitle>
          <DialogDescription>
            The reason feeds your leak report — no card goes to Lost without one.
          </DialogDescription>
        </DialogHeader>
        <Select value={reason} onValueChange={(v) => v && setReason(v as LostReason)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOST_REASONS.map((r) => (
              <SelectItem key={r} value={r}>
                {LOST_REASON_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Keep it
          </Button>
          <Button type="button" size="sm" onClick={() => onConfirm(reason)}>
            Mark lost
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NewLeadDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [busy, setBusy] = React.useState(false)

  async function submit(formData: FormData) {
    setBusy(true)
    const result = await quickCreateLead({
      name: String(formData.get("lead-name") ?? ""),
      phone: String(formData.get("lead-phone") ?? ""),
      interest: String(formData.get("lead-interest") ?? "") || undefined,
    })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("On the board.")
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">New lead</DialogTitle>
          <DialogDescription>Three fields and they&apos;re on the board.</DialogDescription>
        </DialogHeader>
        <form action={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="lead-name">Name</Label>
            <Input id="lead-name" name="lead-name" autoFocus required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-phone">Phone</Label>
            <Input
              id="lead-phone"
              name="lead-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-interest">Interested in (optional)</Label>
            <Input id="lead-interest" name="lead-interest" placeholder="Ceramic coating" />
          </div>
          <Button type="submit" disabled={busy} className="w-full gap-1.5">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Add to pipeline
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LeadSlideOver({
  leadId,
  onClose,
}: {
  leadId: string | null
  onClose: () => void
}) {
  const [loaded, setLoaded] = React.useState<{
    forId: string
    data: LeadDetail | null
  } | null>(null)
  const [note, setNote] = React.useState("")

  React.useEffect(() => {
    if (!leadId) return
    let cancelled = false
    void getLeadDetail(leadId).then((d) => {
      if (!cancelled) setLoaded({ forId: leadId, data: d })
    })
    return () => {
      cancelled = true
    }
  }, [leadId])

  const detail = loaded?.forId === leadId ? loaded.data : null
  const loading = leadId !== null && loaded?.forId !== leadId

  async function saveNote() {
    if (!leadId || !note.trim()) return
    const result = await addLeadNote(leadId, note)
    if (result.ok) {
      toast.success("Noted.")
      setNote("")
      const d = await getLeadDetail(leadId)
      setLoaded({ forId: leadId, data: d })
    }
  }

  return (
    <Sheet open={leadId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {loading || !detail ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="font-display">{detail.name}</SheetTitle>
              <SheetDescription className="space-x-2">
                <span>{detail.phone}</span>
                {detail.email ? <span>· {detail.email}</span> : null}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-6">
              {detail.vehicle ? (
                <span className="inline-flex rounded-full border border-border/60 px-2.5 py-0.5 text-xs text-muted-foreground">
                  {detail.vehicle}
                </span>
              ) : null}

              {detail.quote ? (
                <div className="flex items-center justify-between rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Quote · {detail.quote.status}</p>
                    <p className="font-data text-lg text-foreground">
                      {formatPriceUsd(detail.quote.totalCents)}
                    </p>
                  </div>
                  {detail.quote.publicPath ? (
                    <Link
                      href={detail.quote.publicPath}
                      target="_blank"
                      className="text-sm font-medium text-primary transition-colors hover:text-primary/80"
                    >
                      Open
                    </Link>
                  ) : null}
                </div>
              ) : (
                <Link
                  href={`/customers/quotes/new${detail.customerId ? `?customer=${detail.customerId}&lead=${detail.id}` : ""}`}
                  className="inline-flex h-9 items-center rounded-sm bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Quote this
                </Link>
              )}

              {detail.nextActionAt ? (
                <p className="text-xs text-muted-foreground">
                  Next action due {new Date(detail.nextActionAt).toLocaleString()}
                </p>
              ) : null}

              <div className="space-y-2">
                <p className="label-eyebrow text-muted-foreground/70">Timeline</p>
                {detail.timeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing logged yet — their calls, texts, and quotes will
                    stack up here.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {detail.timeline.map((t) => (
                      <li key={t.id} className="rounded-lg border border-border/40 px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          {t.channel} · {new Date(t.occurred_at).toLocaleString()}
                        </p>
                        <p className="mt-0.5 line-clamp-3 text-sm text-foreground">{t.content}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a note to their file"
                />
                <Button type="button" size="sm" className="h-9 shrink-0" onClick={saveNote}>
                  Save
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
