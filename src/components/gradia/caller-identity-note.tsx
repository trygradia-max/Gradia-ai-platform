import { ShieldCheck, TriangleAlert } from "lucide-react"

import { STRINGS } from "@/lib/strings"
import { describeCallerIdentity } from "@/lib/voice-caller-identity"
import { cn } from "@/lib/utils"

/** Honest "who is this about" line for voice-staged proposals. Renders
 *  nothing for other sources. Icon + text, never color alone. */
export function CallerIdentityNote({
  payload,
}: {
  payload: Record<string, unknown> | null | undefined
}) {
  const view = describeCallerIdentity(payload)
  if (!view) return null
  const ok = view.kind === "verified"
  const text =
    view.kind === "verified"
      ? STRINGS.callerIdentity.verified(view.phone)
      : view.kind === "edited"
        ? STRINGS.callerIdentity.edited(view.callerId, view.current)
        : STRINGS.callerIdentity.unrecorded
  const Icon = ok ? ShieldCheck : TriangleAlert
  return (
    <p
      data-testid="caller-identity-note"
      data-kind={view.kind}
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
        ok
          ? "border-border/60 bg-muted/20 text-muted-foreground"
          : "border-status-warning/25 bg-status-warning-bg text-status-warning-fg"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  )
}
