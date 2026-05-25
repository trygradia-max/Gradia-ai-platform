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
  const [googlePending, setGooglePending] = React.useState(false)
  const [message, setMessage] = React.useState<MessageState>({ kind: "none" })

  async function handleGoogleSignIn() {
    setMessage({ kind: "none" })
    setGooglePending(true)
    try {
      const supabase = createClient()
      const origin = window.location.origin
      const { error: signError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
          // Keep prompt:"select_account" so operators on a shared bay
          // device can pick which Google account to use instead of
          // silently reusing the last one.
          queryParams: {
            prompt: "select_account",
          },
        },
      })
      if (signError) {
        setMessage({ kind: "error", text: signError.message })
        setGooglePending(false)
      }
      // On success, Supabase redirects to Google — no need to clear
      // pending, the page is about to unload anyway.
    } catch (err) {
      setMessage({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't reach Google — try again.",
      })
      setGooglePending(false)
    }
  }

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

  const anyPending = pending || googlePending

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
          One tap, <span className="italic">no passwords</span>.
        </h2>
        <p className="text-sm text-muted-foreground">
          Google in one click, or drop your email for a magic link — no
          shared logins on the bay laptop either way.
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

      <Button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={anyPending}
        variant="outline"
        size="lg"
        className="mt-5 h-11 w-full gap-2.5 border-border/60 bg-background/60 transition-transform duration-200 hover:bg-background/80 active:scale-[0.98]"
      >
        {googlePending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <GoogleIcon className="size-4" />
        )}
        Continue with Google
      </Button>

      <div className="relative my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="label-eyebrow text-muted-foreground/60">or</span>
        <span className="h-px flex-1 bg-border/60" aria-hidden />
      </div>

      <form className="grid gap-4" onSubmit={handleSubmit}>
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
            disabled={anyPending}
            className="h-11 border-border/60 bg-background/60 focus-visible:border-primary/40"
          />
        </div>
        <Button
          type="submit"
          disabled={anyPending}
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
        New here? Sign in — we&apos;ll set the shop up together on the
        other side.
      </p>
    </motion.div>
  )
}

/**
 * Brand-correct Google "G" mark in their four product colors. Inline
 * SVG so we don't need an extra asset round-trip or a depend on an
 * icon pack that doesn't ship the trademark version.
 */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3 .55 4.1 1.62l3.08-3.08C17.36 2.04 14.86 1 12 1 7.32 1 3.31 3.69 1.39 7.62l3.61 2.8C5.91 7.5 8.7 5.4 12 5.4z"
      />
      <path
        fill="#34A853"
        d="M23.5 12.27c0-.78-.07-1.53-.2-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63l3.69 2.86c2.16-1.99 3.74-4.93 3.74-8.73z"
      />
      <path
        fill="#FBBC05"
        d="M5.01 14.42a7.18 7.18 0 0 1 0-4.84L1.39 6.77a11.99 11.99 0 0 0 0 10.46l3.62-2.81z"
      />
      <path
        fill="#4285F4"
        d="M12 23c3.24 0 5.96-1.07 7.95-2.9l-3.69-2.86c-1.02.69-2.34 1.1-4.26 1.1-3.3 0-6.09-2.1-7-5.03l-3.62 2.81C3.31 20.31 7.32 23 12 23z"
      />
    </svg>
  )
}
