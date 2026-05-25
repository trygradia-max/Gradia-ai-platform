"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Merge, Search } from "lucide-react"
import { toast } from "sonner"

import {
  listMergeCandidates,
  mergeCustomers,
  type MergeCandidate,
} from "@/app/actions/customers"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

const SEARCH_DEBOUNCE_MS = 220

function identifierHints(c: MergeCandidate): string {
  return [
    c.name?.trim(),
    c.phone?.trim(),
    c.email?.trim(),
    c.instagram_handle ? `@${c.instagram_handle}` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .slice(0, 3)
    .join(" · ")
}

export function CustomerMergeDialog({
  winnerId,
  winnerName,
}: {
  winnerId: string
  winnerName: string | null
}) {
  const router = useRouter()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [candidates, setCandidates] = React.useState<MergeCandidate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<MergeCandidate | null>(null)
  const [merging, setMerging] = React.useState(false)

  // Initial load + debounced search.
  React.useEffect(() => {
    if (!open) return
    const handle = window.setTimeout(async () => {
      setLoading(true)
      try {
        const list = await listMergeCandidates({
          excludeId: winnerId,
          query,
        })
        setCandidates(list)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't search.")
      } finally {
        setLoading(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [open, query, winnerId])

  function reset() {
    setQuery("")
    setCandidates([])
    setSelected(null)
  }

  async function handleConfirm() {
    if (!selected) return
    const winnerLabel = winnerName?.trim() || "this record"
    const loserLabel =
      selected.name?.trim() || selected.phone || selected.email || "the duplicate"
    const ok = await confirm({
      title: `Merge ${loserLabel} into ${winnerLabel}?`,
      description:
        "Their history moves over and the duplicate record is deleted. There's no undo.",
      confirmLabel: "Merge & delete duplicate",
      tone: "destructive",
    })
    if (!ok) return

    setMerging(true)
    const result = await mergeCustomers({
      winner_id: winnerId,
      loser_id: selected.id,
    })
    setMerging(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    const moved = `${result.moved.interactions} touchpoint${result.moved.interactions === 1 ? "" : "s"}, ${result.moved.leads} lead${result.moved.leads === 1 ? "" : "s"}, ${result.moved.appointments} booking${result.moved.appointments === 1 ? "" : "s"}`
    toast.success(`Merged. Moved ${moved}.`)
    if (result.identifierConflicts.length > 0) {
      toast.message(
        `Kept our existing ${result.identifierConflicts.join(", ")} — another customer already had the duplicate's value.`
      )
    }
    setOpen(false)
    reset()
    router.refresh()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      {confirmDialog}
      <DialogTrigger
        render={
          <Button variant="outline" type="button" className="gap-2" />
        }
      >
        <Merge className="size-4" aria-hidden />
        Merge duplicate
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge a duplicate into this customer</DialogTitle>
          <DialogDescription>
            Search for the other record. We&apos;ll move their full thread —
            calls, texts, emails, leads, bookings — over to{" "}
            <span className="font-medium text-foreground">
              {winnerName?.trim() || "this customer"}
            </span>{" "}
            and then delete the duplicate.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, phone, email, social…"
              className="pl-9"
              autoComplete="off"
            />
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border border-border/60 bg-muted/15">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                Looking…
              </div>
            ) : candidates.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {query
                  ? "No customers match that."
                  : "Nobody else on file yet — duplicates show up here as they come in."}
              </p>
            ) : (
              <ul className="grid">
                {candidates.map((c) => {
                  const isSelected = selected?.id === c.id
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(c)}
                        className={`w-full border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 ${
                          isSelected
                            ? "bg-primary/10"
                            : "hover:bg-muted/40"
                        }`}
                      >
                        <div className="font-medium">
                          {c.name?.trim() || c.phone || c.email || "Unknown"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {identifierHints(c) || "—"}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <DialogClose
            render={
              <Button
                variant="ghost"
                type="button"
                disabled={merging}
                className="h-11 sm:h-9"
              />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={!selected || merging}
            className="h-11 gap-2 sm:h-9"
          >
            {merging ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Merge className="size-4" aria-hidden />
            )}
            Merge &amp; delete duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
