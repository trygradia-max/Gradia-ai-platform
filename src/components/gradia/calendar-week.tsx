"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CloudRain,
  MapPin,
  Plus,
} from "lucide-react"
import { toast } from "sonner"

import { blockTime, rescheduleJob } from "@/app/actions/jobs"
import { JobCardSheet } from "@/components/gradia/job-card-sheet"
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
import { JOB_STATUSES, nextActionsFor } from "@/lib/jobs"
import { capacityMinutesFor } from "@/lib/working-hours"
import { setJobStatus } from "@/app/actions/jobs"
import type { CalendarJob, CalendarWeek } from "@/lib/data/calendar"
import type { JobStatus } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/**
 * Calendar (CRM C4b). Desktop: week grid, status-colored blocks, bay chips,
 * drag-to-reschedule (the move is the owner's; the customer heads-up stages
 * an approval), block time, capacity warning past working hours. Mobile:
 * the day list in drive order — one-tap status, maps link. Status is always
 * dot + label, never color alone.
 */

const DAY_MS = 86_400_000
const GRID_START_HOUR = 7
const GRID_END_HOUR = 19
const PX_PER_MIN = 1.1

const STATUS_TONE: Record<JobStatus, { dot: string; block: string }> = {
  booked: { dot: "bg-status-info-fg", block: "border-status-info-fg/40" },
  confirmed: { dot: "bg-status-info-fg", block: "border-status-info-fg/40" },
  checked_in: { dot: "bg-primary", block: "border-primary/40" },
  in_progress: { dot: "bg-primary", block: "border-primary/50" },
  on_hold: { dot: "bg-status-warning-fg", block: "border-status-warning-fg/50" },
  completed: { dot: "bg-status-success-fg", block: "border-status-success-fg/40" },
  paid: { dot: "bg-status-success-fg", block: "border-status-success-fg/50" },
  closed: { dot: "bg-muted-foreground/50", block: "border-border/50" },
}

const STATUS_LABEL = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s.label])) as Record<
  JobStatus,
  string
>

function dayKey(iso: string): string {
  return new Date(iso).toDateString()
}

export function CalendarWeekView({ initial }: { initial: CalendarWeek }) {
  const router = useRouter()
  const [jobs, setJobs] = React.useState(initial.jobs)
  const [openJobId, setOpenJobId] = React.useState<string | null>(null)
  const [blockOpen, setBlockOpen] = React.useState(false)
  const [dragId, setDragId] = React.useState<string | null>(null)

  const weekStart = new Date(initial.weekStartIso)
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS))
  const openJob = jobs.find((j) => j.id === openJobId) ?? null

  const prevWeek = new Date(weekStart.getTime() - 7 * DAY_MS).toISOString().slice(0, 10)
  const nextWeek = new Date(weekStart.getTime() + 7 * DAY_MS).toISOString().slice(0, 10)

  function jobsOn(day: Date): CalendarJob[] {
    const key = day.toDateString()
    return jobs
      .filter((j) => dayKey(j.scheduledAt) === key)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
  }

  function bookedMinutes(day: Date): number {
    return jobsOn(day).reduce((sum, j) => sum + j.durationMinutes, 0)
  }

  async function dropOn(day: Date, e: React.DragEvent) {
    const id = e.dataTransfer.getData("text/job-id") || dragId
    setDragId(null)
    if (!id) return
    const job = jobs.find((j) => j.id === id)
    if (!job) return

    // Vertical drop position → time of day, snapped to 30 minutes.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const minutesFromTop = Math.max(0, (e.clientY - rect.top) / PX_PER_MIN)
    const snapped = Math.round((GRID_START_HOUR * 60 + minutesFromTop) / 30) * 30
    const newStart = new Date(day)
    newStart.setHours(0, snapped, 0, 0)

    const prev = jobs
    setJobs((cur) =>
      cur.map((j) => (j.id === id ? { ...j, scheduledAt: newStart.toISOString() } : j))
    )
    const result = await rescheduleJob(id, newStart.toISOString())
    if (!result.ok) {
      setJobs(prev)
      toast.error(result.error)
      return
    }
    toast.success(
      result.notificationStaged
        ? "Moved — a heads-up text is waiting in Approvals."
        : "Moved."
    )
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Link
            href={`/calendar?week=${prevWeek}`}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Previous week"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
          <p className="text-sm font-medium text-foreground">
            Week of{" "}
            {weekStart.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
          </p>
          <Link
            href={`/calendar?week=${nextWeek}`}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Next week"
          >
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </div>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setBlockOpen(true)}>
          <Plus className="size-4" aria-hidden />
          Block time
        </Button>
      </div>

      {/* Desktop week grid */}
      <div className="hidden grid-cols-7 gap-2 lg:grid">
        {days.map((day) => {
          const list = jobsOn(day)
          const booked = bookedMinutes(day)
          const capacity = capacityMinutesFor(initial.workingHours, day)
          const overCapacity = booked > capacity
          const isToday = day.toDateString() === new Date().toDateString()
          return (
            <div key={day.toISOString()} className="min-w-0">
              <div className="flex items-center justify-between px-1 pb-1.5">
                <p
                  className={cn(
                    "text-xs font-medium",
                    isToday ? "text-primary" : "text-foreground"
                  )}
                >
                  {day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
                </p>
                {overCapacity ? (
                  <span
                    className="flex items-center gap-1 text-[11px] text-status-warning-fg"
                    title={`${Math.round(booked / 60)}h booked — past your working hours`}
                  >
                    <AlertTriangle className="size-3" aria-hidden />
                    over
                  </span>
                ) : null}
              </div>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  void dropOn(day, e)
                }}
                className={cn(
                  "relative rounded-xl border border-border/50 bg-card/40",
                  isToday && "border-primary/30"
                )}
                style={{ height: (GRID_END_HOUR - GRID_START_HOUR) * 60 * PX_PER_MIN }}
              >
                {list.map((job) => {
                  const start = new Date(job.scheduledAt)
                  const minutes = start.getHours() * 60 + start.getMinutes()
                  const top = Math.max(0, (minutes - GRID_START_HOUR * 60) * PX_PER_MIN)
                  const height = Math.max(34, job.durationMinutes * PX_PER_MIN)
                  const tone = STATUS_TONE[job.status]
                  return (
                    <button
                      key={job.id}
                      type="button"
                      draggable={!job.isBlock}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/job-id", job.id)
                        setDragId(job.id)
                      }}
                      onClick={() => setOpenJobId(job.id)}
                      style={{ top, height }}
                      className={cn(
                        "absolute inset-x-1 overflow-hidden rounded-lg border bg-card px-2 py-1 text-left transition-colors hover:border-border",
                        job.isBlock ? "border-dashed border-border/60 opacity-70" : tone.block
                      )}
                    >
                      <p className="flex items-center gap-1 truncate text-[11px] font-medium text-foreground">
                        <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
                        {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        {job.bay ? (
                          <span className="rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
                            Bay {job.bay}
                          </span>
                        ) : null}
                        {job.weatherFlag ? (
                          <CloudRain className="size-3 text-status-warning-fg" aria-label="Weather risk" />
                        ) : null}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {job.isBlock ? job.serviceName : (job.customerName ?? job.serviceName ?? "Job")}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Mobile: the whole day, phone-only. Drive order = time order. */}
      <div className="space-y-6 lg:hidden">
        {days.map((day) => {
          const list = jobsOn(day)
          if (list.length === 0) return null
          const isToday = day.toDateString() === new Date().toDateString()
          return (
            <section key={day.toISOString()} className="space-y-2">
              <p className={cn("text-xs font-medium", isToday ? "text-primary" : "text-foreground")}>
                {day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
              </p>
              {list.map((job) => (
                <MobileJobRow
                  key={job.id}
                  job={job}
                  onOpen={() => setOpenJobId(job.id)}
                  onStatus={(status) =>
                    setJobs((cur) => cur.map((j) => (j.id === job.id ? { ...j, status } : j)))
                  }
                />
              ))}
            </section>
          )
        })}
        {jobs.length === 0 ? (
          <p className="rounded-2xl border border-border/60 bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing on the books this week — approved bookings land here on
            their own.
          </p>
        ) : null}
      </div>

      <JobCardSheet
        job={openJob}
        onClose={() => setOpenJobId(null)}
        onChanged={(id, status) =>
          setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, status } : j)))
        }
      />

      <BlockTimeDialog
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        onCreated={() => {
          setBlockOpen(false)
          router.refresh()
        }}
        weekStartIso={initial.weekStartIso}
      />
    </div>
  )
}

function MobileJobRow({
  job,
  onOpen,
  onStatus,
}: {
  job: CalendarJob
  onOpen: () => void
  onStatus: (status: JobStatus) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const tone = STATUS_TONE[job.status]
  const next = nextActionsFor(job.status).find((n) => n !== "on_hold")
  const start = new Date(job.scheduledAt)
  const mapsHref =
    job.locationType === "mobile" && job.address
      ? `https://maps.apple.com/?q=${encodeURIComponent(
          Object.values(job.address).filter(Boolean).join(", ")
        )}`
      : null

  async function tapNext() {
    if (!next) return
    setBusy(true)
    const result = await setJobStatus(job.id, next)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    onStatus(next)
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-card px-3.5 py-3",
        job.isBlock ? "border-dashed border-border/60 opacity-70" : tone.block
      )}
    >
      <button type="button" onClick={onOpen} className="flex w-full items-start justify-between gap-2 text-left">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
            {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            <span className="truncate">
              {job.isBlock ? job.serviceName : (job.customerName ?? job.serviceName ?? "Job")}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {STATUS_LABEL[job.status]}
            {job.vehicle ? ` · ${job.vehicle}` : ""}
            {job.serviceName && !job.isBlock ? ` · ${job.serviceName}` : ""}
          </p>
        </div>
      </button>
      {job.isBlock ? null : (
        <div className="mt-2 flex items-center gap-2">
          {next ? (
            <Button type="button" size="sm" className="h-8" disabled={busy} onClick={tapNext}>
              {STATUS_LABEL[next]}
            </Button>
          ) : null}
          {mapsHref ? (
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-sm border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <MapPin className="size-3.5" aria-hidden />
              Maps
            </a>
          ) : null}
        </div>
      )}
    </div>
  )
}

function BlockTimeDialog({
  open,
  onClose,
  onCreated,
  weekStartIso,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  weekStartIso: string
}) {
  const defaultStart = React.useMemo(() => {
    const d = new Date(weekStartIso)
    d.setHours(9, 0, 0, 0)
    // datetime-local wants local "YYYY-MM-DDTHH:mm".
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`
  }, [weekStartIso])
  const [busy, setBusy] = React.useState(false)

  async function submit(formData: FormData) {
    const start = String(formData.get("block-start") ?? "")
    const hours = Number(formData.get("block-hours") ?? 1)
    const label = String(formData.get("block-label") ?? "")
    if (!start) return
    setBusy(true)
    const result = await blockTime(
      new Date(start).toISOString(),
      Math.round(hours * 60),
      label || undefined
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Time blocked.")
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Block time</DialogTitle>
          <DialogDescription>
            Hold space on the calendar — lunch, errands, buffer between jobs.
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="block-start">Start</Label>
            <Input id="block-start" name="block-start" type="datetime-local" defaultValue={defaultStart} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="block-hours">Hours</Label>
            <Input id="block-hours" name="block-hours" inputMode="decimal" defaultValue="1" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="block-label">Label (optional)</Label>
            <Input id="block-label" name="block-label" placeholder="Lunch" />
          </div>
          <Button type="submit" disabled={busy} className="w-full">
            Block it
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
