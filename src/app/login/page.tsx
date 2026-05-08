import { Suspense } from "react"

import { LoginForm } from "@/components/gradia/login-form"

export default function LoginPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-6">
      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  )
}
