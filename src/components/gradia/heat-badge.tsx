import { Flame, Snowflake, Thermometer } from "lucide-react"

import type { HeatLabel, HeatScore } from "@/lib/scoring"

const LABEL_TEXT: Record<HeatLabel, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
}

const LABEL_CLASS: Record<HeatLabel, string> = {
  hot: "bg-status-danger-bg text-status-danger-fg",
  warm: "bg-status-warning-bg text-status-warning-fg",
  cold: "bg-muted text-muted-foreground",
}

const Icon: Record<HeatLabel, typeof Flame> = {
  hot: Flame,
  warm: Thermometer,
  cold: Snowflake,
}

export function HeatBadge({
  heat,
  showScore = false,
}: {
  heat: HeatScore
  showScore?: boolean
}) {
  const I = Icon[heat.label]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${LABEL_CLASS[heat.label]}`}
      title={`Heat score: ${heat.score}/100. Based on lead age, status, recent activity, response history, and repeat-customer signal.`}
    >
      <I className="size-3" aria-hidden />
      {LABEL_TEXT[heat.label]}
      {showScore ? <span className="font-semibold">· {heat.score}</span> : null}
    </span>
  )
}
