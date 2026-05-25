"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export type ConfirmDialogTone = "default" | "destructive"

export type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** One short sentence about what's about to happen. */
  description: string
  /** "Disconnect", "Delete", "Revoke" — what the primary button says. */
  confirmLabel: string
  /** "Cancel" by default. */
  cancelLabel?: string
  tone?: ConfirmDialogTone
  onConfirm: () => void | Promise<void>
  /** Surfaced while onConfirm's promise is pending. */
  pending?: boolean
}

/**
 * One dialog, every "are you sure?" surface in the app. Replaces
 * window.confirm() — those bypass our design system, are jarring on
 * mobile, and look like a bug to a non-technical operator.
 *
 * Pair with a small useConfirm() hook (below) for the most common
 * call site where you just want "open dialog, wait for boolean."
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  pending = false,
}: ConfirmDialogProps) {
  async function handleConfirm() {
    await onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className="h-11 sm:h-9"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={pending}
            className="h-11 gap-2 sm:h-9"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Imperative-flavor helper for the common pattern:
 *   const confirm = useConfirm()
 *   if (await confirm({ title, description, confirmLabel })) { ... }
 *
 * Renders the dialog inside the consuming component's tree, so each
 * caller gets its own instance and there's no global portal coordination
 * needed.
 */
export function useConfirm(): {
  confirm: (
    opts: Omit<
      ConfirmDialogProps,
      "open" | "onOpenChange" | "onConfirm" | "pending"
    >
  ) => Promise<boolean>
  dialog: React.ReactNode
} {
  const [state, setState] = React.useState<{
    open: boolean
    opts: Omit<
      ConfirmDialogProps,
      "open" | "onOpenChange" | "onConfirm" | "pending"
    > | null
    resolve: ((value: boolean) => void) | null
  }>({ open: false, opts: null, resolve: null })

  const confirm = React.useCallback<
    ReturnType<typeof useConfirm>["confirm"]
  >((opts) => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, opts, resolve })
    })
  }, [])

  function close(value: boolean) {
    state.resolve?.(value)
    setState({ open: false, opts: null, resolve: null })
  }

  const dialog = state.opts ? (
    <ConfirmDialog
      open={state.open}
      onOpenChange={(next) => {
        if (!next) close(false)
      }}
      title={state.opts.title}
      description={state.opts.description}
      confirmLabel={state.opts.confirmLabel}
      cancelLabel={state.opts.cancelLabel}
      tone={state.opts.tone}
      onConfirm={() => close(true)}
    />
  ) : null

  return { confirm, dialog }
}
