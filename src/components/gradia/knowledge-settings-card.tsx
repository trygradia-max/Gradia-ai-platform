"use client"

import * as React from "react"

import { HelpTip } from "@/components/gradia/help-tip"
import { STRINGS } from "@/lib/strings"
import { useRouter } from "next/navigation"
import { BookOpen, Check, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  publishKnowledgeEntry,
  removeKnowledgeEntry,
  reviewKnowledgeEntry,
  saveKnowledgeBulkEntry,
  saveKnowledgeEntry,
} from "@/app/actions/knowledge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { StatusPill } from "@/components/ui/status-pill"
import type { ReviewedMemoryRevisionRow } from "@/lib/types/database"

const MAX_CONTENT = 80_000
const SINGLE_ENTRY_CAP = 4_000

/**
 * Rough chunk preview that mirrors lib/knowledge.ts's chunker so the
 * UI can show "will be split into N pieces" without a server round
 * trip. Conservative: counts paragraph breaks ÷ target size.
 */
function previewChunkCount(text: string): number {
  const t = text.trim()
  if (!t) return 0
  if (t.length <= SINGLE_ENTRY_CAP) return 1
  const paragraphs = t.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  return Math.max(paragraphs.length, Math.ceil(t.length / 900))
}

const EXAMPLES = [
  { name: "Deposits", body: "We take a 25% deposit at booking, the rest on completion. Deposits are refundable up to 24 hours before the appointment." },
  { name: "Weather policy", body: "If it rains, we reschedule for free — outdoor detailing happens under cover but full-detail work needs dry conditions." },
  { name: "Brand voice", body: "Speak casual, not corporate. 'We' and 'us', never 'I'. Never quote a price without seeing the year/make first." },
]

export function KnowledgeSettingsCard({
  initialEntries,
}: {
  initialEntries: ReviewedMemoryRevisionRow[]
}) {
  const router = useRouter()
  const entries = initialEntries
  const [sourceName, setSourceName] = React.useState("")
  const [content, setContent] = React.useState("")
  const [pending, setPending] = React.useState<null | "save" | string>(null)

  const chunkCount = previewChunkCount(content)
  const willChunk = chunkCount > 1

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending("save")

    // Auto-chunk longer content. The server still validates; this is
    // just routing.
    if (content.trim().length > SINGLE_ENTRY_CAP) {
      const result = await saveKnowledgeBulkEntry({ sourceName, content })
      setPending(null)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSourceName("")
      setContent("")
      toast.success(
        `Saved ${result.inserted} chunk${result.inserted === 1 ? "" : "s"} for owner review. Nothing is live yet.`
      )
      router.refresh()
      return
    }

    const result = await saveKnowledgeEntry({
      sourceName,
      content,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSourceName("")
    setContent("")
    toast.success(
      result.safetyStatus === "blocked"
        ? "Saved as a blocked candidate. Remove instruction-like content before review."
        : "Saved for owner review. Nothing is live yet."
    )
    router.refresh()
  }

  function pendingKey(
    action: "review" | "publish" | "remove",
    entry: ReviewedMemoryRevisionRow
  ) {
    return `${action}:${entry.source_id}:${entry.revision}`
  }

  async function handleReview(entry: ReviewedMemoryRevisionRow) {
    const key = pendingKey("review", entry)
    setPending(key)
    const result = await reviewKnowledgeEntry({
      sourceId: entry.source_id,
      revision: entry.revision,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Reviewed. Publish separately when you are ready to activate it.")
    router.refresh()
  }

  async function handlePublish(entry: ReviewedMemoryRevisionRow) {
    const key = pendingKey("publish", entry)
    setPending(key)
    const result = await publishKnowledgeEntry({
      sourceId: entry.source_id,
      revision: entry.revision,
      expectedActive: entry.active_revision,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      router.refresh()
      return
    }
    toast.success("Published. Future Gradia work may retrieve this exact revision.")
    router.refresh()
  }

  async function handleRemove(entry: ReviewedMemoryRevisionRow) {
    const key = pendingKey("remove", entry)
    setPending(key)
    const result = await removeKnowledgeEntry({
      sourceId: entry.source_id,
      revision: entry.revision,
      expectedActive: entry.active_revision,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.outcome === "revoked" ? "Revoked from future retrieval." : "Candidate removed.")
    router.refresh()
  }

  function loadExample(ex: (typeof EXAMPLES)[number]) {
    setSourceName(ex.name)
    setContent(ex.body)
  }

  return (
    <Card id="knowledge" className="scroll-mt-20 border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <BookOpen className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="flex items-center gap-1.5 text-base font-medium">
            Reviewed memory
            <HelpTip label="Reviewed memory" text={STRINGS.help.settings.knowledge} />
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Add a candidate, inspect it, then publish an exact revision.
            Gradia retrieves published revisions only.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <form className="grid gap-3" onSubmit={handleSave}>
          <div className="grid gap-2">
            <Label htmlFor="kb-name">Source name</Label>
            <Input
              id="kb-name"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder="e.g. Deposit policy"
              autoComplete="off"
              maxLength={120}
              disabled={pending === "save"}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="kb-content">Content</Label>
            <Textarea
              id="kb-content"
              value={content}
              onChange={(e) =>
                setContent(e.target.value.slice(0, MAX_CONTENT))
              }
              placeholder="One fact per entry, or paste a longer doc and we'll auto-chunk it for you."
              rows={willChunk ? 10 : 5}
              disabled={pending === "save"}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {content.length.toLocaleString()} /{" "}
                {MAX_CONTENT.toLocaleString()}
              </span>
              {willChunk ? (
                <span className="text-foreground">
                  Will split into ~{chunkCount} chunks on save.
                </span>
              ) : null}
            </div>
          </div>
          {entries.length === 0 ? (
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.name}
                  type="button"
                  onClick={() => loadExample(ex)}
                  className="rounded-full border border-border/60 bg-muted/15 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-muted/30"
                >
                  Try: {ex.name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={
                pending === "save" || !sourceName.trim() || !content.trim()
              }
              className="h-11 gap-2 sm:h-9"
            >
              {pending === "save" ? (
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Plus className="size-4" aria-hidden />
              )}
              {willChunk ? `Add candidate (${chunkCount} chunks)` : "Add candidate"}
            </Button>
          </div>
        </form>

        {entries.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {entries.length} memory revision{entries.length === 1 ? "" : "s"}
            </p>
            <ul className="grid gap-2">
              {entries.map((entry) => (
                <li
                  key={`${entry.source_id}:${entry.revision}`}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/15 px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">
                        {entry.source_name} · revision {entry.revision}
                      </p>
                      <StatusPill
                        tone={
                          entry.state === "published"
                            ? "good"
                            : entry.state === "conflicted" ||
                                entry.safety_status === "blocked"
                              ? "bad"
                              : entry.state === "reviewed"
                                ? "accent"
                                : entry.state === "revoked"
                                  ? "warn"
                                  : "muted"
                        }
                      >
                        {entry.state}
                      </StatusPill>
                      {entry.safety_status !== "clean" ? (
                        <StatusPill
                          tone={entry.safety_status === "blocked" ? "bad" : "warn"}
                        >
                          {entry.safety_status === "blocked"
                            ? "instruction risk"
                            : "check personal data"}
                        </StatusPill>
                      ) : null}
                    </div>
                    <p className="line-clamp-3 text-xs text-muted-foreground">
                      {entry.raw_content}
                    </p>
                    {entry.safety_flags.length > 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Review flags: {entry.safety_flags.join(", ")}
                      </p>
                    ) : null}
                  </div>
                  {entry.state === "candidate" && entry.safety_status !== "blocked" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleReview(entry)}
                      disabled={pending !== null}
                      className="min-h-11 gap-1.5 sm:min-h-9"
                    >
                      {pending === pendingKey("review", entry) ? (
                        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                      ) : (
                        <Check className="size-3.5" aria-hidden />
                      )}
                      Review
                    </Button>
                  ) : null}
                  {entry.state === "reviewed" ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handlePublish(entry)}
                      disabled={pending !== null}
                      className="min-h-11 gap-1.5 sm:min-h-9"
                    >
                      {pending === pendingKey("publish", entry) ? (
                        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                      ) : (
                        <ShieldCheck className="size-3.5" aria-hidden />
                      )}
                      Publish
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(entry)}
                    disabled={pending !== null || entry.state === "revoked"}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={
                      entry.state === "published"
                        ? `Revoke ${entry.source_name} revision ${entry.revision}`
                        : `Remove ${entry.source_name} revision ${entry.revision}`
                    }
                  >
                    {pending === pendingKey("remove", entry) ? (
                      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
