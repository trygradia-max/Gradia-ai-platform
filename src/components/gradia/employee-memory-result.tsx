import { MinusCircle } from "lucide-react"
import { StatusPill } from "@/components/ui/status-pill"
import type { SavedMemoryRead } from "@/lib/super-agent/memory-store"

export function EmployeeMemoryResult({ read }: { read: SavedMemoryRead }) {
  return <section className="mt-3 space-y-2" aria-label="Saved business notes">
    <StatusPill tone="muted" icon={<MinusCircle className="size-3" aria-hidden />}>Not published</StatusPill>
    <p className="text-sm">{read.detail.summary}</p>
    {read.detail.notes.length > 0 ? <ul className="space-y-2">
      {read.detail.notes.map(note => <li key={`${note.source_name}-${note.excerpt}`} className="text-sm">
        <p className="font-medium">{note.source_name}</p>
        <p className="text-muted-foreground">{note.excerpt}</p>
      </li>)}
    </ul> : null}
    <p className="text-xs text-muted-foreground">A note is context. It does not grant a new action, and research results were not added to memory.</p>
  </section>
}
