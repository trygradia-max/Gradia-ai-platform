// Real Stripe TEST-MODE test-clock acceptance for the Founder Pilot (Commercial Billing PR F2).
//
// EXPLICITLY OPT-IN, never run by `npm test` / `npm run test:int` / CI. It creates, uses and deletes objects in the
// configured Stripe TEST sandbox ONLY (a test clock, one customer, one subscription, one Checkout Session, meter events).
//
//   GRADIA_STRIPE_TEST_CLOCK_ACCEPTANCE=1 \
//   GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test STRIPE_SECRET_KEY=sk_test_... \
//   node scripts/stripe-test-clock-acceptance.mjs --i-understand-this-mutates-stripe-test [--evidence-out <file.json>]
//
// (or load a local env file you control with `node --env-file=<file> ...`; this script never reads .env files itself.)
// Refuses a live-shaped key, a non-test mode, a foreign API base, CI, and a missing opt-in/confirmation. Prints finite
// step results only: no secret, Stripe id, URL, payload or personal data. Exit 0 = PASSED, 1 = FAILED/INCOMPLETE,
// 3 = REFUSED (nothing was sent), 2 = internal error.
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { writeFileSync } from "node:fs"
import { createServer } from "vite"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const argv = process.argv.slice(2)
const confirmed = argv.includes("--i-understand-this-mutates-stripe-test")
const outIndex = argv.indexOf("--evidence-out")
const evidenceOut = outIndex >= 0 ? argv[outIndex + 1] : null
if (outIndex >= 0 && (!evidenceOut || evidenceOut.startsWith("--"))) {
  console.error("--evidence-out needs a file path")
  process.exit(2)
}

const server = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { "@": resolve(root, "src") } },
})
let code = 2
try {
  const { runTestClockAcceptance, formatEvidence } = await server.ssrLoadModule("/src/lib/stripe-test-clock-acceptance.ts")
  const evidence = await runTestClockAcceptance(process.env, confirmed, { log: (line) => console.log(line) })
  console.log("")
  console.log(formatEvidence(evidence))
  if (evidenceOut) {
    // The evidence record is finite (codes, statuses, integer cents/counts): no id, URL, secret or payload.
    writeFileSync(evidenceOut, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 })
    console.log(`\nEvidence written to the path you gave (${evidence.overall}).`)
  }
  code = evidence.overall === "PASSED" ? 0 : evidence.overall === "REFUSED" ? 3 : 1
} catch {
  // Never echo the error: it could carry configuration.
  console.error("Test-clock acceptance failed internally. Check the Stripe TEST Dashboard (Billing > Subscriptions > Simulations) for a leftover 'gradia-f2-acceptance-*' simulation and delete it.")
} finally {
  await server.close()
}
process.exit(code)
