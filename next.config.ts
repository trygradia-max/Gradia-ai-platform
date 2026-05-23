import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Hosts allowed to load /_next dev resources during `next dev`. Ngrok and
  // similar tunnels are the common case for mobile/HTTPS testing.
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app"],
};

// Sentry wrapper. No-ops in dev / when SENTRY_AUTH_TOKEN is missing —
// the runtime SDK still initializes via instrumentation.ts; this
// wrapper is what uploads source maps + injects the build-time hook.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Sentry CLI auth token. When absent, source map upload is skipped.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Don't ship source maps to clients; Sentry has them, browsers don't.
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  // Tree-shake unused @sentry/* features (replay, tracing) at build.
  disableLogger: true,
});
