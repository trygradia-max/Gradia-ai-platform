"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Camera,
  Car,
  Loader2,
  MapPin,
  Phone,
} from "lucide-react"
import { toast } from "sonner"

import {
  getJobPhotoUrls,
  setJobPaymentStatus,
  setJobStatus,
  updateJobLogistics,
  uploadJobPhoto,
} from "@/app/actions/jobs"
import { Button } from "@/components/ui/button"
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
import { JOB_STATUSES, nextActionsFor } from "@/lib/jobs"
import { formatPriceUsd } from "@/lib/service-pricing"
import type { CalendarJob } from "@/lib/data/calendar"
import type { JobHoldReason, JobPaymentStatus, JobStatus } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/**
 * The job card (CRM C4a) — one slide-over, every status one tap deep.
 * Mobile jobs show address/maps/travel/access/weather; shop jobs show
 * bay / key tag. checked_in prompts walk-around photos; completed prompts
 * after-photos. Customer-facing follow-ups ride the C5 catalog — nothing
 * sends from here.
 */

const STATUS_LABEL = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s.label])) as Record<
  JobStatus,
  string
>

const NEXT_ACTION_COPY: Partial<Record<JobStatus, string>> = {
  confirmed: "Confirm",
  checked_in: "Check in",
  in_progress: "Start work",
  on_hold: "Hold",
  completed: "Complete",
  paid: "Mark paid",
  closed: "Close out",
}

const HOLD_REASONS: { key: JobHoldReason; label: string }[] = [
  { key: "customer", label: "Waiting on the customer" },
  { key: "weather", label: "Weather" },
  { key: "parts", label: "Waiting on parts/supplies" },
  { key: "payment", label: "Waiting on payment" },
]

export function JobCardSheet({
  job,
  onClose,
  onChanged,
}: {
  job: CalendarJob | null
  onClose: () => void
  onChanged: (id: string, status: JobStatus) => void
}) {
  if (!job) {
    return (
      <Sheet open={false} onOpenChange={() => onClose()}>
        <SheetContent side="right" />
      </Sheet>
    )
  }
  // key={job.id} remounts the body per job — all local state resets cleanly.
  return <JobCardBody key={job.id} job={job} onClose={onClose} onChanged={onChanged} />
}

function JobCardBody({
  job,
  onClose,
  onChanged,
}: {
  job: CalendarJob
  onClose: () => void
  onChanged: (id: string, status: JobStatus) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [holdOpen, setHoldOpen] = React.useState(false)
  const [holdReason, setHoldReason] = React.useState<JobHoldReason>("customer")
  const [photos, setPhotos] = React.useState<{ before: string[]; after: string[] } | null>(null)
  const [status, setStatus] = React.useState<JobStatus | null>(null)
  const beforeInput = React.useRef<HTMLInputElement | null>(null)
  const afterInput = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void getJobPhotoUrls(job.id).then((p) => {
      if (!cancelled) setPhotos(p)
    })
    return () => {
      cancelled = true
    }
  }, [job.id])

  const current = status ?? job.status

  async function tap(next: JobStatus, reason?: JobHoldReason) {
    setBusy(true)
    const result = await setJobStatus(job.id, next, reason ?? null)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setStatus(next)
    setHoldOpen(false)
    onChanged(job.id, next)
    if (next === "checked_in") {
      toast.info("Checked in — grab the walk-around photos below.")
    } else if (next === "completed") {
      toast.info("Done — add after-photos; follow-ups run per your automations.")
    } else {
      toast.success(`${STATUS_LABEL[next]}.`)
    }
    router.refresh()
  }

  async function pay(next: JobPaymentStatus) {
    const result = await setJobPaymentStatus(job.id, next)
    if (!result.ok) toast.error(result.error)
    else toast.success(next === "paid" ? "Marked paid." : `Payment: ${next}.`)
  }

  async function addPhoto(phase: "before" | "after", file: File | null) {
    if (!file) return
    const fd = new FormData()
    fd.append("photo", file)
    const result = await uploadJobPhoto(job.id, phase, fd)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setPhotos((prev) => ({
      before: phase === "before" ? [...(prev?.before ?? []), result.url] : (prev?.before ?? []),
      after: phase === "after" ? [...(prev?.after ?? []), result.url] : (prev?.after ?? []),
    }))
  }

  const when = new Date(job.scheduledAt)
  const mapsHref =
    job.locationType === "mobile" && job.address
      ? `https://maps.apple.com/?q=${encodeURIComponent(
          Object.values(job.address).filter(Boolean).join(", ")
        )}`
      : null

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-display">
            {job.isBlock ? "Blocked time" : (job.customerName ?? "Job")}
          </SheetTitle>
          <SheetDescription>
            {when.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            {job.serviceName ? ` · ${job.serviceName}` : ""}
            {` · ${job.durationMinutes} min`}
          </SheetDescription>
        </SheetHeader>

        {job.isBlock ? null : (
          <div className="space-y-6 px-4 pb-8">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {job.customerPhone ? (
                <a
                  href={`tel:${job.customerPhone}`}
                  className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                >
                  <Phone className="size-3.5" aria-hidden />
                  {job.customerPhone}
                </a>
              ) : null}
              {job.vehicle ? (
                <span className="inline-flex items-center gap-1">
                  <Car className="size-3.5" aria-hidden />
                  {job.vehicle}
                </span>
              ) : null}
            </div>

            {/* Status — where the job is, and the one-tap next steps. */}
            <div className="space-y-2">
              <p className="label-eyebrow text-muted-foreground/70">Status</p>
              <p className="text-sm font-medium text-foreground">{STATUS_LABEL[current]}</p>
              <div className="flex flex-wrap gap-2">
                {nextActionsFor(current).map((next) =>
                  next === "on_hold" ? (
                    <Button
                      key={next}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setHoldOpen((v) => !v)}
                    >
                      {NEXT_ACTION_COPY[next] ?? STATUS_LABEL[next]}
                    </Button>
                  ) : (
                    <Button
                      key={next}
                      type="button"
                      size="sm"
                      variant={next === "completed" || next === "paid" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => tap(next)}
                      className="gap-1.5"
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                      {NEXT_ACTION_COPY[next] ?? STATUS_LABEL[next]}
                    </Button>
                  )
                )}
              </div>
              {holdOpen ? (
                <div className="flex items-center gap-2 pt-1">
                  <Select
                    value={holdReason}
                    onValueChange={(v) => v && setHoldReason(v as JobHoldReason)}
                  >
                    <SelectTrigger className="h-8 w-56 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOLD_REASONS.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="sm" className="h-8" onClick={() => tap("on_hold", holdReason)}>
                    Hold it
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Payment — manual toggle only (P9), links to Stripe elsewhere. */}
            <div className="space-y-2">
              <p className="label-eyebrow text-muted-foreground/70">Payment</p>
              <div className="flex gap-1 rounded-lg border border-border/60 p-0.5">
                {(["unpaid", "deposit", "paid"] as JobPaymentStatus[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => pay(p)}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors",
                      job.paymentStatus === p
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Location-specific fields (spec §C4: render only what applies). */}
            {job.locationType === "mobile" ? (
              <div className="space-y-2">
                <p className="label-eyebrow text-muted-foreground/70">On location</p>
                {mapsHref ? (
                  <a
                    href={mapsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary transition-colors hover:text-primary/80"
                  >
                    <MapPin className="size-4" aria-hidden />
                    Open in Maps
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground">No address on file.</p>
                )}
                {job.travelFeeCents ? (
                  <p className="text-sm text-muted-foreground">
                    Travel fee <span className="font-data">{formatPriceUsd(job.travelFeeCents)}</span>
                  </p>
                ) : null}
                <MobileAccessRow job={job} />
              </div>
            ) : (
              <ShopFieldsRow job={job} />
            )}

            {/* Photos — walk-around at check-in, after-shots at completion. */}
            <div className="space-y-2">
              <p className="label-eyebrow text-muted-foreground/70">Photos</p>
              <div className="grid grid-cols-2 gap-3">
                <PhotoColumn
                  title="Walk-around"
                  urls={photos?.before ?? []}
                  highlight={current === "checked_in"}
                  onPick={() => beforeInput.current?.click()}
                />
                <PhotoColumn
                  title="After"
                  urls={photos?.after ?? []}
                  highlight={current === "completed"}
                  onPick={() => afterInput.current?.click()}
                />
              </div>
              <input
                ref={beforeInput}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => addPhoto("before", e.target.files?.[0] ?? null)}
              />
              <input
                ref={afterInput}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => addPhoto("after", e.target.files?.[0] ?? null)}
              />
            </div>

            {job.internalNote && !job.isBlock ? (
              <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {job.internalNote}
              </p>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function PhotoColumn({
  title,
  urls,
  highlight,
  onPick,
}: {
  title: string
  urls: string[]
  highlight: boolean
  onPick: () => void
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border p-2.5",
        highlight ? "border-primary/40 bg-primary/5" : "border-border/50"
      )}
    >
      <p className="text-xs font-medium text-foreground">{title}</p>
      {urls.length > 0 ? (
        <div className="grid grid-cols-3 gap-1.5">
          {urls.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={u}
              alt={`${title} photo ${i + 1}`}
              className="aspect-square rounded-md object-cover"
            />
          ))}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onPick}
        className="h-8 w-full gap-1.5"
      >
        <Camera className="size-3.5" aria-hidden />
        Add photo
      </Button>
    </div>
  )
}

function MobileAccessRow({ job }: { job: CalendarJob }) {
  const [saving, setSaving] = React.useState(false)
  const access = (job.accessNotes ?? {}) as Record<string, unknown>
  const [water, setWater] = React.useState(Boolean(access.water))
  const [power, setPower] = React.useState(Boolean(access.power))
  const [weather, setWeather] = React.useState(job.weatherFlag)

  async function save(patch: { water?: boolean; power?: boolean; weatherFlag?: boolean }) {
    setSaving(true)
    const result = await updateJobLogistics(job.id, patch)
    setSaving(false)
    if (!result.ok) toast.error(result.error)
  }

  return (
    <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={water}
          disabled={saving}
          onChange={(e) => {
            setWater(e.target.checked)
            void save({ water: e.target.checked })
          }}
          className="size-4 accent-primary"
        />
        Water on site
      </label>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={power}
          disabled={saving}
          onChange={(e) => {
            setPower(e.target.checked)
            void save({ power: e.target.checked })
          }}
          className="size-4 accent-primary"
        />
        Power on site
      </label>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={weather}
          disabled={saving}
          onChange={(e) => {
            setWeather(e.target.checked)
            void save({ weatherFlag: e.target.checked })
          }}
          className="size-4 accent-primary"
        />
        Weather risk
      </label>
    </div>
  )
}

function ShopFieldsRow({ job }: { job: CalendarJob }) {
  const [bay, setBay] = React.useState(job.bay ?? "")
  const [keyTag, setKeyTag] = React.useState(job.keyTag ?? "")

  async function save() {
    const result = await updateJobLogistics(job.id, { bay, keyTag })
    if (!result.ok) toast.error(result.error)
    else toast.success("Saved.")
  }

  return (
    <div className="space-y-2">
      <p className="label-eyebrow text-muted-foreground/70">In the shop</p>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`bay-${job.id}`} className="text-xs">
            Bay
          </Label>
          <Input
            id={`bay-${job.id}`}
            value={bay}
            onChange={(e) => setBay(e.target.value)}
            placeholder="1"
            className="h-8 w-16"
          />
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor={`key-${job.id}`} className="text-xs">
            Key tag
          </Label>
          <Input
            id={`key-${job.id}`}
            value={keyTag}
            onChange={(e) => setKeyTag(e.target.value)}
            placeholder="Hook 4"
            className="h-8"
          />
        </div>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}
