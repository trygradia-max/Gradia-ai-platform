import {
  readinessStatusLabel,
  type ChannelKey,
  type ChannelReadiness,
} from "@/lib/channel-readiness"

const ORDER: ChannelKey[] = ["calls", "texting", "email", "meta"]

const TITLES: Record<ChannelKey, string> = {
  calls: "Calls",
  texting: "Texting",
  email: "Email",
  meta: "Facebook lead forms",
}

/**
 * One status per channel. A texting review never replaces the calls status.
 * `readinessStatusLabel` is the handoff vocabulary; a missing deployment stays
 * Unavailable rather than Ready.
 */
export function ChannelStatusList({
  channels,
}: {
  channels: Record<ChannelKey, ChannelReadiness>
}) {
  return (
    <ul className="grid w-full gap-3" aria-label="Channel status">
      {ORDER.map((key) => {
        const channel = channels[key]
        const label = readinessStatusLabel(channel) ?? "Unavailable"
        return (
            <li
            key={key}
            className="min-w-0 rounded-md border border-border/60 bg-muted/15 px-3.5 py-3 break-words"
            data-channel={key}
          >
            <p className="text-sm font-medium text-foreground">{TITLES[key]}</p>
            <p className="mt-1 text-sm font-medium text-foreground">{label}</p>
            <p className="mt-1 text-sm text-muted-foreground">{channel.message}</p>
          </li>
        )
      })}
    </ul>
  )
}
