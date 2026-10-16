import { MinusCircle } from "lucide-react"
import { StatusPill } from "@/components/ui/status-pill"
import type { SavedBrowserCheck } from "@/lib/super-agent/browser-store"

export function EmployeeBrowserResult({ check }: { check: SavedBrowserCheck }) {
  return <section className="mt-3 space-y-2" aria-label="Cloud browser check">
    <StatusPill tone="muted" icon={<MinusCircle className="size-3" aria-hidden />}>Not connected</StatusPill>
    <p className="text-sm">{check.detail.summary}</p>
    <p className="text-sm text-muted-foreground">{check.detail.handoff}</p>
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      <li>No browser session was started.</li>
      <li>No password was stored.</li>
      <li>This computer was not used.</li>
      {check.detail.named_provider_ignored && <li>A named browser service was ignored.</li>}
    </ul>
  </section>
}
