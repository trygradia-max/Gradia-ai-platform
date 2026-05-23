/**
 * Client-side Sentry init. Loaded on every page navigation; mirrors
 * the server config's "error capture only, no traces, no PII"
 * defaults. Env-gated via NEXT_PUBLIC_SENTRY_DSN so dev stays quiet.
 */

import * as Sentry from "@sentry/nextjs"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // No replay by default — easy to flip on later when we want
    // visual repros for tricky bugs.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NEXT_PUBLIC_VERCEL_ENV ??
      "development",
  })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
