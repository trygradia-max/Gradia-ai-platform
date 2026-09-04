"use client"

import * as React from "react"
import { Download } from "lucide-react"

import { HelpTip } from "@/components/gradia/help-tip"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { STRINGS } from "@/lib/strings"

const ENTITIES: { value: string; label: string }[] = [
  { value: "customers", label: "Customers" },
  { value: "vehicles", label: "Vehicles" },
  { value: "leads", label: "Leads" },
  { value: "appointments", label: "Appointments" },
  { value: "conversations", label: "Conversations" },
]

/**
 * B-01 — data export. A plain navigation to /api/export triggers the
 * browser's normal file download: the session cookie carries auth, and
 * Content-Disposition (set server-side) names the file. No client-side
 * fetch/blob plumbing needed.
 */
export function DataExportCard() {
  const [entity, setEntity] = React.useState("customers")

  function download(format: "csv" | "json") {
    window.location.href = `/api/export?entity=${entity}&format=${format}`
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/40 bg-card/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          Export your data
          <HelpTip label="Export your data" text={STRINGS.help.settings.dataExport} />
        </p>
        <p className="text-xs text-muted-foreground">
          Customers, vehicles, leads, appointments and conversations — CSV or
          JSON, tenant-scoped to this shop.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Select value={entity} onValueChange={(v) => v && setEntity(v)}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENTITIES.map((e) => (
              <SelectItem key={e.value} value={e.value}>
                {e.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => download("csv")}
        >
          <Download className="size-3.5" aria-hidden />
          CSV
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => download("json")}
        >
          <Download className="size-3.5" aria-hidden />
          JSON
        </Button>
      </div>
    </div>
  )
}
