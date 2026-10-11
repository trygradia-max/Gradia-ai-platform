import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"

import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * Visible label, control, helper, optional inline error. Error is border +
 * text on the field, not a toast. Callers keep their existing control.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined
  const control = Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      id,
      "aria-describedby": describedBy,
      "aria-invalid": error ? true : undefined,
    })
  })

  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-status-danger-fg">
          {error}
        </p>
      ) : null}
    </div>
  )
}
