"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion"
import { CheckCircle2, Loader2, Mail, TriangleAlert } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"

type MessageState =
  | { kind: "none" }
  | { kind: "success"; text: string }
  | { kind: "error"; text: string }

export function LoginForm() {
  const searchParams = useSearchParams()
  const next = searchParams.get("next") ?? "/dashboard"
  const error = searchParams.get("error")
  const reduce = useReducedMotion()

  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<MessageState>({ kind: "none" })

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setMessage({ kind: "none" })
    const formData = new FormData(e.currentTarget)
    const email = String(formData.get("email") ?? "")
    setPending(true)

    try {
      const supabase = createClient()
      const origin = window.location.origin
      const { error: signError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      })
      if (signError) {
        setMessage({ kind: "error", text: signError.message })
        setPending(false)
        return
      }
      setMessage({
        kind: "success",
        text: "Magic link sent — check your inbox.",
      })
    } catch (err) {
      setMessage({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't reach the server — try again.",
      })
    }
    setPending(false)
  }

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_OUT_EXPO, delay: 0.05 }}
      className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border/60 bg-card/95 p-7 shadow-2xl shadow-black/40 ring-1 ring-foreground/5"
    >
      {/* Soft accent rail along the top of the card — same hairline
       *  vocabulary as the AI lead "what we caught" panel. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />

      <div className="space-y-1.5">
        <p className="label-eyebrow text-muted-foreground/70">Sign in</p>
        <h2 className="font-display text-2xl leading-tight tracking-[-0.015em] text-foreground">
          One link, <span className="italic">no passwords</span>.
        </h2>
        <p className="text-sm text-muted-foreground">
          Drop your email. We&apos;ll send a one-tap sign-in straight to your
          inbox — no shared logins on the bay laptop.
        </p>
      </div>

      <AnimatePresence initial={false}>
        {error ? (
          <motion.p
            key="param-error"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
            className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {error === "config"
                ? "Supabase config missing — flag the engineer on call."
                : "That didn't go through — try again."}
            </span>
          </motion.p>
        ) : null}
      </AnimatePresence>

      <form className="mt-5 grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-2">
          <Label
            htmlFor="email"
            className="label-eyebrow text-muted-foreground/70"
          >
            Work email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@studio.com"
            disabled={pending}
            className="h-11 border-border/60 bg-background/60 focus-visible:border-primary/40"
          />
        </div>
        <Button
          type="submit"
          disabled={pending}
          size="lg"
          className="h-11 gap-2 transition-transform duration-200 active:scale-[0.98]"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Sending the link…
            </>
          ) : (
            <>
              <Mail className="size-4" aria-hidden />
              Email me a link
            </>
          )}
        </Button>
      </form>

      <AnimatePresence initial={false} mode="wait">
        {message.kind !== "none" ? (
          <motion.div
            key={message.kind}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
            className={
              message.kind === "success"
                ? "mt-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
                : "mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            }
          >
            {message.kind === "success" ? (
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0"
                aria-hidden
              />
            ) : (
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden
              />
            )}
            <span>{message.text}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        New here? Drop your email — we&apos;ll set the shop up together.
      </p>
    </motion.div>
  )
}
