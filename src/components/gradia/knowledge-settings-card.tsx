"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BookOpen, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  deleteKnowledgeEntry,
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
import type { ShopKnowledgeRow } from "@/lib/types/database"

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
  initialEntries: ShopKnowledgeRow[]
}) {
  const router = useRouter()
  const [entries, setEntries] = React.useState(initialEntries)
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
        `Saved ${result.inserted} chunk${result.inserted === 1 ? "" : "s"} — drafters can cite this now.`
      )
      // The server `revalidatePath("/settings")` will repaint with the
      // new rows on the next navigation; for the optimistic count we
      // just bump the heading by refetching on revalidate.
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
    setEntries([
      {
        id: result.id,
        shop_id: entries[0]?.shop_id ?? "",
        source_name: sourceName.trim(),
        content: content.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      ...entries,
    ])
    setSourceName("")
    setContent("")
    toast.success("Saved — drafters can cite this now.")
  }

  async function handleDelete(id: string) {
    setPending(id)
    const result = await deleteKnowledgeEntry(id)
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setEntries(entries.filter((e) => e.id !== id))
    toast.success("Removed.")
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
          <CardTitle className="text-base font-medium">
            Shop knowledge
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            FAQs, policies, brand voice — whatever we paste here gets
            pulled into draft replies and the BI chat when it&apos;s
            relevant.
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
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-4" aria-hidden />
              )}
              {willChunk ? `Add document (${chunkCount} chunks)` : "Add entry"}
            </Button>
          </div>
        </form>

        {entries.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {entries.length} entr{entries.length === 1 ? "y" : "ies"} live
            </p>
            <ul className="grid gap-2">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/15 px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {entry.source_name}
                    </p>
                    <p className="line-clamp-3 text-xs text-muted-foreground">
                      {entry.content}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(entry.id)}
                    disabled={pending === entry.id}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${entry.source_name}`}
                  >
                    {pending === entry.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
