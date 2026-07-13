import Link from "next/link"
import { Suspense } from "react"
import { ArrowRight, Sparkles } from "lucide-react"

import { GrainOverlay } from "@/components/gradia/grain-overlay"
import { LoginForm } from "@/components/gradia/login-form"
import { MeshBackground } from "@/components/gradia/mesh-background"

export default function LoginPage() {
  return (
    <div className="relative isolate flex min-h-svh flex-col items-center justify-center gap-8 overflow-hidden bg-background px-6 py-12">
      <GrainOverlay />
      <MeshBackground />

      <header className="relative flex flex-col items-center gap-5 text-center">
        <Link
          href="/"
          className="group inline-flex items-center gap-2.5 rounded-full border border-border/40 bg-card/60 px-3 py-1.5 backdrop-blur-sm transition-colors hover:border-border"
        >
          <span className="flex size-5 items-center justify-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/25">
            <Sparkles className="size-3" aria-hidden />
          </span>
          <span className="font-display text-sm tracking-tight text-foreground">
            Gradia
          </span>
        </Link>

        <div className="max-w-xl space-y-3">
          <h1 className="font-display text-[clamp(2.25rem,5.5vw,3.5rem)] leading-[1.02] tracking-[-0.03em] text-foreground">
            Your AI office,{" "}
            <span className="italic">ready when you are</span>.
          </h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground sm:text-base">
            Voice, email, SMS, DMs, the front desk — caught, drafted, queued
            for your yes.
          </p>
        </div>
      </header>

      <Suspense
        fallback={
          <div className="text-sm text-muted-foreground">Loading…</div>
        }
      >
        <LoginForm />
      </Suspense>

      <Link
        href="/how-it-works"
        className="group relative inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        New here? See how Gradia works
        <ArrowRight
          className="size-3 transition-transform duration-200 group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
    </div>
  )
}
