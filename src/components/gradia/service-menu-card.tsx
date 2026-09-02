"use client"

import * as React from "react"

import { HelpTip } from "@/components/gradia/help-tip"
import { STRINGS } from "@/lib/strings"
import { ChevronDown, Loader2, Plus, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  addService,
  applyDetailerTemplate,
  deleteService,
  updateServiceMenu,
} from "@/app/actions/services"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SIZE_CLASS_LABELS } from "@/lib/service-menu"
import { describePrice, VEHICLE_SIZE_CLASSES } from "@/lib/service-pricing"
import type { ServiceRow, VehicleSizeClass } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/**
 * Service menu editor (CRM C3a) — the shop's brain. Prices set here feed CRM
 * quotes, the phone receptionist, and Whisper drafts through ONE resolution
 * module, so this is the only place a price ever changes.
 */
export function ServiceMenuCard({ initialServices }: { initialServices: ServiceRow[] }) {
  const [services, setServices] = React.useState(initialServices)
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function seedTemplate() {
    setBusy(true)
    const result = await applyDetailerTemplate()
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.added > 0
        ? `Added ${result.added} starter services — tune the prices to your market.`
        : "Your menu already has all the starter services."
    )
    window.location.reload()
  }

  async function quickAdd(formData: FormData) {
    const name = String(formData.get("new-name") ?? "").trim()
    if (!name) return
    setBusy(true)
    const result = await addService({ name, priceDollars: 0, durationHours: 1 })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setServices((prev) => [...prev, result.service])
    setOpenId(result.service.id)
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-1.5 font-display text-lg tracking-tight">
            Service menu
            <HelpTip label="Service menu" text={STRINGS.help.settings.services} />
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Prices by vehicle size, durations, and condition bumps. Quotes,
            phone answers, and drafts all read from this one menu.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={busy}
          onClick={seedTemplate}
        >
          <Sparkles className="size-4" aria-hidden />
          Start from a template
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {services.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
            No services yet. Add one below, or start from the detailer
            template and adjust the numbers.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {services.map((s) => (
              <ServiceEditorRow
                key={s.id}
                service={s}
                open={openId === s.id}
                onToggle={() => setOpenId(openId === s.id ? null : s.id)}
                onSaved={(next) =>
                  setServices((prev) => prev.map((p) => (p.id === next.id ? next : p)))
                }
                onDeleted={() =>
                  setServices((prev) => prev.filter((p) => p.id !== s.id))
                }
              />
            ))}
          </ul>
        )}

        <form action={quickAdd} className="flex items-center gap-2">
          <Input
            name="new-name"
            placeholder="Add a service — e.g. Maintenance Wash"
            className="h-9"
            disabled={busy}
          />
          <Button type="submit" size="sm" variant="outline" className="h-9 gap-1.5" disabled={busy}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

type MultiplierDraft = { label: string; multiplier: string }

function ServiceEditorRow({
  service,
  open,
  onToggle,
  onSaved,
  onDeleted,
}: {
  service: ServiceRow
  open: boolean
  onToggle: () => void
  onSaved: (next: ServiceRow) => void
  onDeleted: () => void
}) {
  const [saving, setSaving] = React.useState(false)
  const [name, setName] = React.useState(service.name)
  const [description, setDescription] = React.useState(service.description ?? "")
  const [price, setPrice] = React.useState(String(service.price_cents / 100))
  const [duration, setDuration] = React.useState(String(service.duration_minutes))
  const [sizePrices, setSizePrices] = React.useState<Record<string, string>>(() => {
    const map = (service.base_price_by_size ?? {}) as Record<string, unknown>
    return Object.fromEntries(
      VEHICLE_SIZE_CLASSES.map((size) => [
        size,
        typeof map[size] === "number" ? String((map[size] as number) / 100) : "",
      ])
    )
  })
  const [sizeDurations, setSizeDurations] = React.useState<Record<string, string>>(() => {
    const map = (service.duration_by_size ?? {}) as Record<string, unknown>
    return Object.fromEntries(
      VEHICLE_SIZE_CLASSES.map((size) => [
        size,
        typeof map[size] === "number" ? String(map[size]) : "",
      ])
    )
  })
  const [multipliers, setMultipliers] = React.useState<MultiplierDraft[]>(() =>
    (service.condition_multipliers ?? []).map((m) => ({
      label: m.label ?? m.key,
      multiplier: String(m.multiplier),
    }))
  )
  const [isAddon, setIsAddon] = React.useState(service.is_addon ?? false)
  const [mobileEligible, setMobileEligible] = React.useState(
    service.mobile_eligible ?? true
  )
  const [active, setActive] = React.useState(service.active ?? true)

  async function save() {
    const priceDollars = Number(price)
    const durationMinutes = Number(duration)
    if (!Number.isFinite(priceDollars) || priceDollars < 0) {
      toast.error("Base price needs to be a number.")
      return
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
      toast.error("Duration needs to be at least a minute.")
      return
    }
    const numOrNull = (v: string) => {
      const t = v.trim()
      if (!t) return null
      const n = Number(t)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    setSaving(true)
    const result = await updateServiceMenu(service.id, {
      name,
      description: description || null,
      priceDollars,
      durationMinutes,
      priceBySizeDollars: Object.fromEntries(
        VEHICLE_SIZE_CLASSES.map((s) => [s, numOrNull(sizePrices[s] ?? "")])
      ),
      durationBySizeMinutes: Object.fromEntries(
        VEHICLE_SIZE_CLASSES.map((s) => [s, numOrNull(sizeDurations[s] ?? "")])
      ),
      multipliers: multipliers
        .map((m) => ({ label: m.label, multiplier: Number(m.multiplier) }))
        .filter((m) => m.label.trim() && Number.isFinite(m.multiplier)),
      isAddon,
      mobileEligible,
      active,
    })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${result.service.name} saved — every quote surface updated.`)
    onSaved(result.service)
  }

  async function remove() {
    setSaving(true)
    const result = await deleteService(service.id)
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    onDeleted()
  }

  return (
    <li className="px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {service.name}
            {service.active === false ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (hidden from quoting)
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-data">{describePrice(service)}</span>
            {" · "}
            <span className="font-data">{service.duration_minutes} min</span>
            {service.is_addon ? " · add-on" : ""}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="mt-4 space-y-4 border-t border-border/40 pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`name-${service.id}`}>Name</Label>
              <Input
                id={`name-${service.id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`desc-${service.id}`}>Description</Label>
              <Input
                id={`desc-${service.id}`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What the caller hears about it"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`price-${service.id}`}>Base price ($)</Label>
              <Input
                id={`price-${service.id}`}
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Used when a size below is blank.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`dur-${service.id}`}>Duration (minutes)</Label>
              <Input
                id={`dur-${service.id}`}
                inputMode="numeric"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <p className="label-eyebrow text-muted-foreground/70">
              Price &amp; time by vehicle size
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {VEHICLE_SIZE_CLASSES.map((size: VehicleSizeClass) => (
                <div key={size} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">
                    {SIZE_CLASS_LABELS[size]}
                  </span>
                  <Input
                    aria-label={`${SIZE_CLASS_LABELS[size]} price`}
                    inputMode="decimal"
                    placeholder="$"
                    className="h-8"
                    value={sizePrices[size] ?? ""}
                    onChange={(e) =>
                      setSizePrices((p) => ({ ...p, [size]: e.target.value }))
                    }
                  />
                  <Input
                    aria-label={`${SIZE_CLASS_LABELS[size]} minutes`}
                    inputMode="numeric"
                    placeholder="min"
                    className="h-8 w-20"
                    value={sizeDurations[size] ?? ""}
                    onChange={(e) =>
                      setSizeDurations((p) => ({ ...p, [size]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="label-eyebrow text-muted-foreground/70">
              Condition bumps
            </p>
            {multipliers.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label="Condition label"
                  placeholder="Heavy soiling"
                  className="h-8"
                  value={m.label}
                  onChange={(e) =>
                    setMultipliers((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                    )
                  }
                />
                <Input
                  aria-label="Multiplier"
                  inputMode="decimal"
                  placeholder="1.25"
                  className="h-8 w-24"
                  value={m.multiplier}
                  onChange={(e) =>
                    setMultipliers((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, multiplier: e.target.value } : x
                      )
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() =>
                    setMultipliers((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                  <span className="sr-only">Remove condition</span>
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() =>
                setMultipliers((prev) => [...prev, { label: "", multiplier: "1.2" }])
              }
            >
              <Plus className="size-4" aria-hidden />
              Add a condition bump
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={isAddon}
                onChange={(e) => setIsAddon(e.target.checked)}
                className="size-4 accent-primary"
              />
              Add-on service
            </label>
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={mobileEligible}
                onChange={(e) => setMobileEligible(e.target.checked)}
                className="size-4 accent-primary"
              />
              Available for mobile jobs
            </label>
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="size-4 accent-primary"
              />
              Active
            </label>
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" disabled={saving} onClick={save} className="gap-1.5">
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Save service
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={remove}
              className="text-muted-foreground hover:text-status-danger-fg"
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
