"use client"

import * as React from "react"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { ChoiceQuestion, ChoicesQuestion, MixQuestion, NoteQuestion, NumberQuestion, Question } from "@/lib/onboarding-baseline/catalog"
import { QUESTION_COPY, issueMessage } from "@/lib/onboarding-baseline/copy"
import { firstUnit, limitsText, type FieldState } from "@/lib/onboarding-baseline/form-model"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

const T = STRINGS.pages.startingPoint
const NOT_SURE = "__not_sure__"

type Props = {
  question: Question
  field: FieldState | undefined
  onChange: (next: FieldState | undefined) => void
  /** Issue code to show inline (after the owner tried to continue). */
  errorCode?: string
  disabled?: boolean
}

const radioClass = "size-5 shrink-0 accent-primary"
const rowClass = "flex min-h-11 items-center gap-3 rounded-sm px-1 text-sm text-foreground"

/**
 * One catalog question, rendered from its kind. Native radios, checkboxes and text inputs: they work with
 * every screen reader and mobile keyboard and need no custom focus handling. Every control has a visible
 * label; hint and error are tied in with aria-describedby; "I'm not sure" is an explicit, always-available
 * answer (where the catalog allows it) and is the only way a question becomes unknown. Nothing is
 * pre-filled and there are no placeholders, so the form never suggests a number.
 */
export function QuestionField(props: Props) {
  const { question: q, errorCode } = props
  const copy = QUESTION_COPY[q.key]
  const id = `q-${q.key}`
  const helpId = copy.help ? `${id}-help` : undefined
  const errId = errorCode ? `${id}-error` : undefined
  const describedBy = [errId, helpId].filter(Boolean).join(" ") || undefined

  return (
    <fieldset
      id={id}
      aria-describedby={describedBy}
      className="grid min-w-0 scroll-mt-24 gap-3 rounded-md bg-card p-4 ring-1 ring-border sm:p-5"
      data-invalid={errorCode ? "true" : undefined}
    >
      <legend className="float-left w-full text-sm font-medium text-foreground">
        {copy.label}
        {q.optional ? <span className="ml-2 text-xs font-normal text-muted-foreground">{T.optional}</span> : null}
      </legend>
      <div className="clear-both grid gap-3">
        {copy.help ? (
          <p id={helpId} className="text-xs text-muted-foreground">
            {copy.help}
          </p>
        ) : null}
        <Control {...props} id={id} describedBy={describedBy} />
        {errorCode ? (
          <p id={errId} role="alert" className="text-xs font-medium text-status-danger-fg">
            {issueMessage(errorCode)}
          </p>
        ) : null}
      </div>
    </fieldset>
  )
}

function Control(props: Props & { id: string; describedBy?: string }) {
  const { question: q } = props
  switch (q.kind) {
    case "number":
      return <NumberControl {...props} q={q} />
    case "choice":
      return <ChoiceControl {...props} q={q} />
    case "choices":
      return <ChoicesControl {...props} q={q} />
    case "mix":
      return <MixControl {...props} q={q} />
    case "note":
      return <NoteControl {...props} q={q} />
  }
}

function NotSure({ id, checked, onToggle, disabled }: { id: string; checked: boolean; onToggle: (on: boolean) => void; disabled?: boolean }) {
  return (
    <div>
      <label className={cn(rowClass, "w-fit")}>
        <input
          type="checkbox"
          id={`${id}-not-sure`}
          className={radioClass}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {T.notSure}
      </label>
      {checked ? <p className="pl-1 text-xs text-muted-foreground">{T.notSureHint}</p> : null}
    </div>
  )
}

function NumberControl({ q, field, onChange, errorCode, disabled, id, describedBy }: Props & { q: NumberQuestion; id: string; describedBy?: string }) {
  const copy = QUESTION_COPY[q.key]
  const units = Object.keys(q.units)
  const unknown = field?.mode === "unknown"
  const unit = field && field.mode !== "unknown" && "unit" in field ? field.unit : firstUnit(q)
  const range = field?.mode === "range"
  const text = field?.mode === "number" ? field.text : ""
  const [lo, hi] = field?.mode === "range" ? [field.minText, field.maxText] : ["", ""]
  const decimal = !q.units[unit]?.integer
  const limits = limitsText(q, unit)
  const invalid = errorCode ? true : undefined
  const suffix = units.length === 1 ? copy.suffix : null

  const setNumber = (t: string) => onChange({ mode: "number", unit, text: t })
  const setRange = (a: string, b: string) => onChange({ mode: "range", unit, minText: a, maxText: b })

  return (
    <div className="grid gap-3">
      {units.length > 1 ? (
        <div role="radiogroup" aria-label="How do you want to answer?" className="grid gap-0.5">
          {units.map((u) => (
            <label key={u} className={rowClass}>
              <input
                type="radio"
                name={`${id}-unit`}
                className={radioClass}
                checked={!unknown && unit === u}
                disabled={disabled}
                // Switching units clears the figure: "30" as a count and "30" as a percent are different answers.
                onChange={() => onChange({ mode: "number", unit: u, text: "" })}
              />
              {copy.units?.[u] ?? u}
            </label>
          ))}
        </div>
      ) : null}

      {!unknown && !range ? (
        <div className="flex items-center gap-3">
          <Input
            id={`${id}-input`}
            type="text"
            inputMode={decimal ? "decimal" : "numeric"}
            autoComplete="off"
            className="h-11 max-w-40"
            aria-label={copy.label}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            disabled={disabled}
            value={text}
            onChange={(e) => setNumber(e.target.value)}
          />
          {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
        </div>
      ) : null}

      {!unknown && range ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            {T.rangeFrom}
            <Input
              type="text"
              inputMode={decimal ? "decimal" : "numeric"}
              autoComplete="off"
              className="h-11 w-32 text-sm text-foreground"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={disabled}
              value={lo}
              onChange={(e) => setRange(e.target.value, hi)}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {T.rangeTo}
            <Input
              type="text"
              inputMode={decimal ? "decimal" : "numeric"}
              autoComplete="off"
              className="h-11 w-32 text-sm text-foreground"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={disabled}
              value={hi}
              onChange={(e) => setRange(lo, e.target.value)}
            />
          </label>
          {suffix ? <span className="self-end pb-3 text-sm text-muted-foreground">{suffix}</span> : null}
        </div>
      ) : null}

      {!unknown && limits ? <p className="text-xs text-muted-foreground">{limits}</p> : null}

      <div className="flex flex-wrap items-center gap-x-4">
        {!unknown && q.allowsRange ? (
          <button
            type="button"
            aria-pressed={range}
            disabled={disabled}
            className="min-h-11 rounded-sm px-1 text-sm text-accent-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => (range ? setNumber("") : setRange("", ""))}
          >
            {range ? T.singleToggle : T.rangeToggle}
          </button>
        ) : null}
        {q.allowsUnknown ? (
          <NotSure
            id={id}
            checked={unknown}
            disabled={disabled}
            onToggle={(on) => onChange(on ? { mode: "unknown" } : { mode: "number", unit, text: "" })}
          />
        ) : null}
      </div>
    </div>
  )
}

function ChoiceControl({ q, field, onChange, disabled, id }: Props & { q: ChoiceQuestion; id: string; describedBy?: string }) {
  const copy = QUESTION_COPY[q.key]
  const value = field?.mode === "unknown" ? NOT_SURE : field?.mode === "choice" ? field.value : ""
  const options: Array<[string, string]> = [...q.choices.map((c): [string, string] => [c, copy.choices?.[c] ?? c]), ...(q.allowsUnknown ? ([[NOT_SURE, T.notSure]] as Array<[string, string]>) : [])]
  return (
    <div className="grid gap-0.5 sm:grid-cols-2">
      {options.map(([val, label]) => (
        <label key={val} className={rowClass}>
          <input
            type="radio"
            name={`${id}-choice`}
            className={radioClass}
            checked={value === val}
            disabled={disabled}
            onChange={() => onChange(val === NOT_SURE ? { mode: "unknown" } : { mode: "choice", value: val })}
          />
          {label}
        </label>
      ))}
      {q.optional && value ? (
        <button
          type="button"
          disabled={disabled}
          className="min-h-11 w-fit rounded-sm px-1 text-left text-sm text-accent-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => onChange(undefined)}
        >
          Clear this answer
        </button>
      ) : null}
    </div>
  )
}

function ChoicesControl({ q, field, onChange, disabled, id }: Props & { q: ChoicesQuestion; id: string; describedBy?: string }) {
  const copy = QUESTION_COPY[q.key]
  const unknown = field?.mode === "unknown"
  const values = field?.mode === "choices" ? field.values : []
  const toggle = (c: string, on: boolean) => {
    const next = on ? [...values, c] : values.filter((v) => v !== c)
    onChange(next.length ? { mode: "choices", values: next } : undefined)
  }
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5 sm:grid-cols-2">
        {q.choices.map((c) => (
          <label key={c} className={rowClass}>
            <input
              type="checkbox"
              className={radioClass}
              checked={values.includes(c)}
              disabled={disabled || unknown}
              onChange={(e) => toggle(c, e.target.checked)}
            />
            {copy.choices?.[c] ?? c}
          </label>
        ))}
      </div>
      {q.allowsUnknown ? (
        <NotSure id={id} checked={unknown} disabled={disabled} onToggle={(on) => onChange(on ? { mode: "unknown" } : undefined)} />
      ) : null}
    </div>
  )
}

function MixControl({ q, field, onChange, disabled, id, describedBy }: Props & { q: MixQuestion; id: string; describedBy?: string }) {
  const copy = QUESTION_COPY[q.key]
  const unknown = field?.mode === "unknown"
  const percents = field?.mode === "mix" ? field.percents : {}
  const total = Object.values(percents).reduce((s, t) => s + (Number.isFinite(Number(t)) && t.trim() !== "" ? Number(t) : 0), 0)
  const entered = Object.values(percents).some((t) => t.trim() !== "")
  const set = (key: string, t: string) => onChange({ mode: "mix", percents: { ...percents, [key]: t } })
  return (
    <div className="grid gap-3">
      {!unknown ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {q.choices.map((c) => (
              <label key={c} className="flex min-h-11 items-center justify-between gap-3 text-sm text-foreground">
                <span>{copy.choices?.[c] ?? c}</span>
                <span className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    className="h-11 w-24 text-right"
                    aria-describedby={describedBy}
                    disabled={disabled}
                    value={percents[c] ?? ""}
                    onChange={(e) => set(c, e.target.value)}
                  />
                  <span aria-hidden className="text-muted-foreground">%</span>
                </span>
              </label>
            ))}
          </div>
          <p id={`${id}-total`} role="status" className="font-data text-xs text-muted-foreground">
            {entered ? (Math.abs(total - 100) < 1e-9 ? T.mixTotalOk : T.mixTotal(Math.round(total * 100) / 100)) : null}
          </p>
        </>
      ) : null}
      {q.allowsUnknown ? (
        <NotSure id={id} checked={unknown} disabled={disabled} onToggle={(on) => onChange(on ? { mode: "unknown" } : undefined)} />
      ) : null}
    </div>
  )
}

function NoteControl({ q, field, onChange, disabled, describedBy, id }: Props & { q: NoteQuestion; id: string; describedBy?: string }) {
  const text = field?.mode === "note" ? field.text : ""
  return (
    <div className="grid gap-1.5">
      <Textarea
        id={`${id}-input`}
        aria-label={QUESTION_COPY[q.key].label}
        aria-describedby={describedBy}
        maxLength={q.maxLength}
        disabled={disabled}
        className="min-h-24 text-base"
        value={text}
        onChange={(e) => onChange(e.target.value ? { mode: "note", text: e.target.value } : undefined)}
      />
      <p className="font-data text-xs text-muted-foreground">{T.noteCount(text.length, q.maxLength)}</p>
    </div>
  )
}
