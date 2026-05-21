import Link from "next/link"
import { Suspense } from "react"

import { LoginForm } from "@/components/gradia/login-form"

export default function LoginPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-6">
      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
        <LoginForm />
      </Suspense>
      <Link
        href="/how-it-works"
        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        New here? See how Gradia works →
      </Link>
    </div>
  )
}
