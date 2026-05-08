"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function LoginForm() {
  const searchParams = useSearchParams()
  const next = searchParams.get("next") ?? "/dashboard"
  const error = searchParams.get("error")

  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setMessage(null)
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
        setMessage(signError.message)
        setPending(false)
        return
      }
      setMessage("Sign-in link sent — check the inbox.")
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : "Unable to reach authentication."
      )
    }
    setPending(false)
  }

  return (
    <Card className="w-full max-w-md border-border/80 shadow-lg">
      <CardHeader>
        <CardTitle className="text-xl">Sign in to Gradia</CardTitle>
        <CardDescription>
          Magic link authentication backed by Supabase. No shared passwords on
          devices in the bay.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error === "config"
              ? "Supabase environment variables are missing."
              : "We could not complete sign-in. Try again."}
          </p>
        ) : null}
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@studio.com"
            />
          </div>
          <Button
            type="submit"
            disabled={pending}
            className="w-full gap-2 transition-transform duration-200 active:scale-[0.99]"
          >
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Sending link…
              </>
            ) : (
              "Email me a link"
            )}
          </Button>
        </form>
        {message ? (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          New here? Sign in, and we&apos;ll set up our shop together.
        </p>
      </CardContent>
    </Card>
  )
}
