/**
 * Server + edge Sentry init. Next.js calls this from
 * `register()` once per runtime (nodejs / edge). Both runtimes share
 * the same conservative defaults: error capture only, no traces,
 * no PII. Env-gated so dev never sends anything unless SENTRY_DSN
 * is explicitly set.
 *
 * Per @sentry/nextjs docs, top-level Sentry.init lives in
 * instrumentation files; the wizard generates similar boilerplate.
 */

import * as Sentry from "@sentry/nextjs"

const SHARED_INIT = {
  dsn: process.env.SENTRY_DSN,
  // We log webhook signatures + customer data through routes Sentry
  // would otherwise auto-capture. Keep PII off until we're ready to
  // scrub deliberately.
  sendDefaultPii: false,
  // Trace nothing by default — flip on per-env when we want perf data.
  tracesSampleRate: 0,
  // Reasonable defaults; the wizard recommends keeping these
  // conservative on first install.
  enabled: Boolean(process.env.SENTRY_DSN),
  environment:
    process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development",
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init(SHARED_INIT)
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(SHARED_INIT)
  }
}

export const onRequestError = Sentry.captureRequestError
