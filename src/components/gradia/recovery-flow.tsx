"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CheckCircle2,
  FileUp,
  Loader2,
  Mail,
  Phone,
  UserPlus,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { approveRecoveryCandidates } from "@/app/actions/recovery"
import { Button } from "@/components/ui/button"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { SectionHeader } from "@/components/gradia/motion/section-header"
import type { ReviewCandidate } from "@/lib/recovery/review"
import type { ImportSourceType } from "@/lib/types/database"
import { cn } from "@/lib/utils"

type Phase = "idle" | "uploading" | "estimate" | "extracting" | "review"

type ImportResponse = {
  ok: boolean
  jobId?: string
  counts?: { total: number; kept: number; dropped: number }
  estimate?: { units: number; credits: number; retailCents: number }
  error?: string
}

type ExtractResponse = {
  ok: boolean
  done?: boolean
  extracted?: number
  remaining?: number
  candidates?: ReviewCandidate[]
  error?: string
}

const SOURCES: { id: ImportSourceType; label: string; accept: string; hint: string }[] = [
  { id: "contacts_csv", label: "Customer list (.csv)", accept: ".csv", hint: "A CSV export from your CRM, Google Contacts, or a spreadsheet" },
  { id: "vcard", label: "Contacts (.vcf)", accept: ".vcf,.vcard", hint: "A vCard address book" },
  { id: "mbox", label: "Email (.mbox)", accept: ".mbox", hint: "A Gmail / Google Takeout export" },
]

const DECISION_GROUPS: {
  kind: ReviewCandidate["decision"]["kind"]
  title: string
  blurb: string
}[] = [
  { kind: "new", title: "Ready to add", blurb: "New to your customer list." },
  { kind: "merge_into", title: "Possible duplicates", blurb: "Looks like someone you already have — we'll fill the gaps." },
  { kind: "ambiguous", title: "Needs a look", blurb: "Conflicting details — your call." },
]

export function RecoveryFlow({
  initialJobId,
  initialCandidates,
}: {
  initialJobId?: string
  initialCandidates?: ReviewCandidate[]
}) {
  const router = useRouter()
  const [phase, setPhase] = React.useState<Phase>(
    initialCandidates && initialCandidates.length >= 0 && initialJobId
      ? "review"
      : "idle"
  )
  const [source, setSource] = React.useState<ImportSourceType>("mbox")
  const [file, setFile] = React.useState<File | null>(null)
  const [jobId, setJobId] = React.useState<string | null>(initialJobId ?? null)
  const [estimate, setEstimate] = React.useState<ImportResponse["estimate"] | null>(null)
  const [counts, setCounts] = React.useState<ImportResponse["counts"] | null>(null)
  const [progress, setProgress] = React.useState<{ extracted: number; remaining: number } | null>(null)
  const [candidates, setCandidates] = React.useState<ReviewCandidate[]>(
    initialCandidates ?? []
  )
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [approving, setApproving] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement | null>(null)

  const activeSource = SOURCES.find((s) => s.id === source)!

  async function upload() {
    if (!file) return
    setPhase("uploading")
    const fd = new FormData()
    fd.append("file", file)
    fd.append("source_type", source)
    try {
      const res = await fetch("/api/recovery/import", { method: "POST", body: fd })
      const data = (await res.json()) as ImportResponse
      if (!data.ok || !data.jobId) {
        toast.error(data.error ?? "Couldn't read that file.")
        setPhase("idle")
        return
      }
      setJobId(data.jobId)
      setCounts(data.counts ?? null)
      setEstimate(data.estimate ?? null)
      setPhase("estimate")
    } catch {
      toast.error("Upload failed — try again.")
      setPhase("idle")
    }
  }

  async function runExtraction() {
    if (!jobId) return
    setPhase("extracting")
    setProgress({ extracted: 0, remaining: estimate?.units ?? 0 })
    try {
      // Drain the chunked extractor until the job reports done.
      // Bounded so a stuck job can't loop forever.
      for (let i = 0; i < 500; i++) {
        const res = await fetch(`/api/recovery/import/${jobId}/extract`, {
          method: "POST",
        })
        const data = (await res.json()) as ExtractResponse
        if (!data.ok) {
          toast.error(data.error ?? "Extraction stopped.")
          setPhase("estimate")
          return
        }
        setProgress((p) => ({
          extracted: (p?.extracted ?? 0) + (data.extracted ?? 0),
          remaining: data.remaining ?? 0,
        }))
        if (data.done) {
          setCandidates(data.candidates ?? [])
          setPhase("review")
          return
        }
      }
      toast.error("This import is taking too long — we'll keep working in the background.")
    } catch {
      toast.error("Extraction failed — try again.")
      setPhase("estimate")
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectAll(keys: string[]) {
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = keys.every((k) => next.has(k))
      for (const k of keys) {
        if (allOn) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }

  async function approve() {
    if (!jobId || selected.size === 0) return
    setApproving(true)
    const keys = [...selected]
    const result = await approveRecoveryCandidates(jobId, keys)
    setApproving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      `Added ${result.added} and updated ${result.merged} — they're in your customers now.`
    )
    setCandidates((prev) => prev.filter((c) => !selected.has(c.key)))
    setSelected(new Set())
    router.refresh()
  }

  return (
    <div className="space-y-8">
      {phase === "idle" || phase === "uploading" ? (
        <UploadStep
          sources={SOURCES}
          source={source}
          onSource={setSource}
          file={file}
          onFile={setFile}
          fileRef={fileRef}
          accept={activeSource.accept}
          hint={activeSource.hint}
          uploading={phase === "uploading"}
          onScan={upload}
        />
      ) : null}

      {phase === "estimate" && estimate && counts ? (
        <EstimateStep
          counts={counts}
          estimate={estimate}
          onConfirm={runExtraction}
          onCancel={() => setPhase("idle")}
        />
      ) : null}

      {phase === "extracting" ? <ExtractingStep progress={progress} /> : null}

      {phase === "review" ? (
        <ReviewStep
          candidates={candidates}
          selected={selected}
          onToggle={toggle}
          onSelectAll={selectAll}
          approving={approving}
          onApprove={approve}
        />
      ) : null}
    </div>
  )
}

function UploadStep({
  sources,
  source,
  onSource,
  file,
  onFile,
  fileRef,
  accept,
  hint,
  uploading,
  onScan,
}: {
  sources: typeof SOURCES
  source: ImportSourceType
  onSource: (s: ImportSourceType) => void
  file: File | null
  onFile: (f: File | null) => void
  fileRef: React.RefObject<HTMLInputElement | null>
  accept: string
  hint: string
  uploading: boolean
  onScan: () => void
}) {
  const [dragging, setDragging] = React.useState(false)
  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Import your customers"
        title={
          <>
            Bring your customers <span className="italic">in</span>.
          </>
        }
        subtitle="Upload a CSV from your CRM (or a contacts / email export) — we'll pull out names, phones, and vehicles into your Gradia CRM. You approve before anything's added, and we can draft win-backs for anyone who's gone quiet."
      />

      <div className="flex flex-wrap gap-2">
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              onSource(s.id)
              onFile(null)
            }}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
              source === s.id
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <MotionCard interactive={false} className="p-0">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const f = e.dataTransfer.files?.[0]
            if (f) onFile(f)
          }}
          className={cn(
            "flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors",
            dragging ? "border-primary/50 bg-primary/5" : "border-border/60"
          )}
        >
          <FileUp className="size-6 text-primary" aria-hidden />
          <p className="font-display text-lg text-foreground">
            {file ? file.name : "Drop your file here"}
          </p>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </MotionCard>

      <Button
        type="button"
        size="lg"
        disabled={!file || uploading}
        onClick={onScan}
        className="h-11 gap-2"
      >
        {uploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {uploading ? "Reading your file…" : "Scan for customers"}
      </Button>
    </section>
  )
}

function EstimateStep({
  counts,
  estimate,
  onConfirm,
  onCancel,
}: {
  counts: { kept: number; dropped: number }
  estimate: { units: number; credits: number }
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <MotionCard interactive={false} className="space-y-4 p-6 sm:p-8">
      <div className="space-y-1">
        <p className="label-eyebrow text-muted-foreground/70">Here&apos;s the plan</p>
        <p className="font-display text-2xl text-foreground">
          {counts.kept} worth a <span className="italic">closer look</span>.
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          We filtered out {counts.dropped} newsletters and automated messages.
          Reading the rest will use about{" "}
          <span className="font-medium text-foreground">{estimate.credits} credits</span> —
          nothing&apos;s saved or sent until you approve it.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" size="lg" onClick={onConfirm} className="h-11 gap-2">
          Read them ({estimate.credits} credits)
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} className="h-11">
          Start over
        </Button>
      </div>
    </MotionCard>
  )
}

function ExtractingStep({
  progress,
}: {
  progress: { extracted: number; remaining: number } | null
}) {
  const total = (progress?.extracted ?? 0) + (progress?.remaining ?? 0)
  return (
    <MotionCard interactive={false} className="flex items-center gap-4 p-6 sm:p-8">
      <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
      <div>
        <p className="font-display text-lg text-foreground">Reading through them…</p>
        <p className="text-sm text-muted-foreground">
          {progress ? `${progress.extracted} of ${total} so far` : "Getting started"}
        </p>
      </div>
    </MotionCard>
  )
}

function ReviewStep({
  candidates,
  selected,
  onToggle,
  onSelectAll,
  approving,
  onApprove,
}: {
  candidates: ReviewCandidate[]
  selected: Set<string>
  onToggle: (key: string) => void
  onSelectAll: (keys: string[]) => void
  approving: boolean
  onApprove: () => void
}) {
  if (candidates.length === 0) {
    return (
      <MotionCard interactive={false} className="px-6 py-16 text-center">
        <p className="font-display text-2xl text-foreground">
          <span className="italic">All</span>{" "}sorted.
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          Nothing left to review — the customers you approved are in your list now.
        </p>
      </MotionCard>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader
          eyebrow="What we found"
          title={
            <>
              {candidates.length} past{" "}
              <span className="italic">{candidates.length === 1 ? "customer" : "customers"}</span>.
            </>
          }
        />
        <Button
          type="button"
          size="lg"
          disabled={approving || selected.size === 0}
          onClick={onApprove}
          className="h-11 gap-2"
        >
          {approving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
          Add {selected.size > 0 ? selected.size : ""} selected
        </Button>
      </div>

      {DECISION_GROUPS.map((g) => {
        const items = candidates.filter((c) => c.decision.kind === g.kind)
        if (items.length === 0) return null
        const keys = items.map((c) => c.key)
        const allOn = keys.every((k) => selected.has(k))
        return (
          <section key={g.kind} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="label-eyebrow text-muted-foreground/70">
                  {g.title} · {items.length}
                </p>
                <p className="text-sm text-muted-foreground">{g.blurb}</p>
              </div>
              <button
                type="button"
                onClick={() => onSelectAll(keys)}
                className="shrink-0 text-sm font-medium text-primary transition-colors hover:text-primary/80"
              >
                {allOn ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid gap-2">
              {items.map((c) => (
                <CandidateRow
                  key={c.key}
                  candidate={c}
                  checked={selected.has(c.key)}
                  onToggle={() => onToggle(c.key)}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ReviewCandidate
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
        checked ? "border-primary/40 bg-primary/5" : "border-border/60 hover:border-border"
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border"
        )}
        aria-hidden
      >
        {checked ? <CheckCircle2 className="size-4" /> : null}
      </span>
      <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {candidate.name ?? "Unknown name"}
          {candidate.vehicle ? (
            <span className="ml-2 font-normal text-muted-foreground">
              {candidate.vehicle}
            </span>
          ) : null}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {candidate.phones[0] ? (
            <span className="inline-flex items-center gap-1">
              <Phone className="size-3" aria-hidden />
              {candidate.phones[0]}
            </span>
          ) : null}
          {candidate.emails[0] ? (
            <span className="inline-flex items-center gap-1">
              <Mail className="size-3" aria-hidden />
              {candidate.emails[0]}
            </span>
          ) : null}
        </p>
      </div>
    </button>
  )
}
