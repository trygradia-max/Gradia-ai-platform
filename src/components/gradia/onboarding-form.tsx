"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { createShop } from "@/app/actions/shop"
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

export function OnboardingForm() {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const formData = new FormData(e.currentTarget)
    const name = String(formData.get("name") ?? "").trim()
    setPending(true)
    const result = await createShop({ name })
    setPending(false)
    if (!result.ok) {
      setError(result.error)
    }
  }

  return (
    <Card className="w-full max-w-lg border-border/80 shadow-xl">
      <CardHeader>
        <CardTitle className="text-xl">Create your shop</CardTitle>
        <CardDescription>
          One shop record anchors every lead, service, and appointment you
          create in Gradia. You can extend settings later inside the JSON{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            settings
          </code>{" "}
          column.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="name">Studio / shop name</Label>
            <Input
              id="name"
              name="name"
              required
              maxLength={120}
              placeholder="North Shore Auto Studio"
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={pending}
            className="transition-transform duration-200 active:scale-[0.99]"
          >
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Provisioning…
              </>
            ) : (
              "Continue to dashboard"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
