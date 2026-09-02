import Link from "next/link"
import { Check, CircleOff, type LucideIcon } from "lucide-react"

import { ConnectionConnectButton } from "@/components/gradia/connection-connect-button"
import { HelpTip } from "@/components/gradia/help-tip"
import { buttonVariants } from "@/components/ui/button"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

/**
 * The Connections screen tile (BUILD_REFERENCE §4). Server Component so it can
 * take an icon; status is icon + text, never color alone. Three states:
 *   CONNECTED      — ✓ + identity + Manage
 *   NOT CONNECTED  — accent Connect (popup for OAuth, link otherwise)
 *   NOT AVAILABLE  — the integration isn't wired for this workspace: an
 *                    honest line naming what is missing in owner terms, and
 *                    no Connect control (UX-001 — replaces "Coming soon",
 *                    which presented a server setting as a roadmap promise).
 * `connected` must come from `connectionStatus()` — never from a display
 * field — so this tile and the Home channel card can never disagree.
 */
export function ConnectionTile({
  icon: Icon,
  name,
  description,
  connected,
  available = true,
  unavailableReason,
  connectedLabel,
  connectedDetail,
  connectHref,
  manageHref,
  popup = false,
  help,
}: {
  icon: LucideIcon
  name: string
  description: string
  connected: boolean
  available?: boolean
  /** Required whenever `available` can be false — what the owner reads. */
  unavailableReason?: string
  connectedLabel?: string | null
  connectedDetail?: string | null
  connectHref?: string
  manageHref?: string
  popup?: boolean
  /** One or two narrator sentences behind the ⓘ (STRINGS.help). */
  help?: string
}) {
  const connectedLine =
    [connectedLabel, connectedDetail].filter(Boolean).join(" · ") || description
  const unavailable = !available

  return (
    <div
      className="flex flex-col gap-4 rounded-md border border-border/60 bg-card/40 p-5 transition-colors hover:border-border"
      data-connection-state={
        connected ? "connected" : unavailable ? "unavailable" : "disconnected"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60 text-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-success-bg px-2 py-0.5 text-xs font-medium text-status-success-fg">
            <Check className="size-3.5" aria-hidden /> {STRINGS.connections.connected}
          </span>
        ) : unavailable ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <CircleOff className="size-3.5" aria-hidden /> {STRINGS.connections.notAvailable}
          </span>
        ) : null}
      </div>

      <div className="space-y-1">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          {name}
          {help ? <HelpTip label={name} text={help} /> : null}
        </p>
        <p className="text-sm text-muted-foreground">
          {connected ? connectedLine : description}
        </p>
      </div>

      <div className="mt-auto pt-1">
        {unavailable ? (
          // Honest NOT AVAILABLE: says what is missing, offers nothing dead.
          <p className="text-xs text-muted-foreground">
            {unavailableReason ?? STRINGS.connections.notAvailable}
          </p>
        ) : connected ? (
          manageHref ? (
            <Link
              href={manageHref}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {STRINGS.connections.manage}
            </Link>
          ) : null
        ) : !connectHref ? null : popup ? (
          <ConnectionConnectButton href={connectHref} />
        ) : (
          <Link
            href={connectHref}
            className={cn(buttonVariants({ size: "sm" }), "gap-2")}
          >
            {STRINGS.connections.connect}
          </Link>
        )}
      </div>
    </div>
  )
}
