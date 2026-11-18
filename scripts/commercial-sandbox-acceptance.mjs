// One command for the Founder Pilot Stripe SANDBOX acceptance report.
//
//   npm run billing:sandbox-acceptance                 offline checks only (never touches the network)
//   npm run billing:sandbox-acceptance -- --local      offline CI mode: exit 0 iff the LOCAL FIXTURE checks pass.
//                                                      Never prints READY; real Stripe acceptance is labelled NOT RUN.
//   npm run billing:sandbox-acceptance -- --network    + a READ-ONLY Stripe test-mode check (GET only)
//   ... --evidence <file>                              real test-clock evidence from `npm run billing:test-clock-acceptance`
//   ... --attest hosted_checkout_completion --attest stripe_delivered_webhook
//                                                      the operator's explicit claim that a human did those manual steps
//   node --env-file=<your local env file> scripts/commercial-sandbox-acceptance.mjs --network --evidence <file> --attest ...
//
// Prints READY or a finite, ordered list of blockers. READY needs: the F1 contract + exact subscription items + webhook
// rule + worker readiness (offline fixtures and configuration), a verified Stripe sandbox (--network) AND current real
// test-clock evidence with the manual steps attested. Exit 0 = READY, 1 = NOT_READY, 2 = internal error.
// It never prints a secret, key, object id, URL or payload; it never writes to Stripe, Supabase or disk (it only READS the
// evidence file you name); it refuses a live-shaped configuration; and it does not read .env files by itself.
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { createServer } from "vite"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
import { readFileSync } from "node:fs"
const argv = process.argv.slice(2)
const network = argv.includes("--network") || process.env.GRADIA_SANDBOX_VERIFY_NETWORK === "1"
const localOnly = argv.includes("--local")
const valueAfter = (flag) => argv.flatMap((arg, i) => (arg === flag && argv[i + 1] && !argv[i + 1].startsWith("--") ? [argv[i + 1]] : []))
const attested = valueAfter("--attest")
const evidencePath = valueAfter("--evidence")[0] ?? null
let evidence = null
if (evidencePath) {
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"))
  } catch {
    evidence = { unreadable: true } // judged INVALID by the report; the path and content are never echoed
  }
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
  const { verifyStripeSandbox } = await server.ssrLoadModule("/src/lib/stripe-sandbox-verifier.ts")
  const { buildSandboxReport, formatSandboxReport } = await server.ssrLoadModule("/src/lib/commercial-sandbox-report.ts")
  const verification = network ? await verifyStripeSandbox(process.env) : "skipped"
  const report = buildSandboxReport({ env: process.env, verification, evidence, attested })
  console.log(formatSandboxReport(report))
  code = localOnly ? (report.localFixture.status === "PASS" ? 0 : 1) : report.status === "READY" ? 0 : 1
} catch {
  // Never echo the error: it could carry configuration.
  console.error("Sandbox acceptance command failed internally; nothing was changed.")
} finally {
  await server.close()
}
process.exit(code)
