// One command for the Founder Pilot Stripe SANDBOX acceptance report.
//
//   npm run billing:sandbox-acceptance                 offline checks only (never touches the network)
//   npm run billing:sandbox-acceptance -- --network    + a READ-ONLY Stripe test-mode check (GET only)
//   node --env-file=.env.local scripts/commercial-sandbox-acceptance.mjs --network
//
// Prints READY or a finite, ordered list of blockers. Exit 0 = READY, 1 = NOT_READY, 2 = internal error.
// It never prints a secret, key, object id, URL or payload; it never writes to Stripe, Supabase or disk;
// it refuses a live-shaped configuration; and it does not read .env files by itself.
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { createServer } from "vite"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const network = process.argv.includes("--network") || process.env.GRADIA_SANDBOX_VERIFY_NETWORK === "1"

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
  const report = buildSandboxReport({ env: process.env, verification })
  console.log(formatSandboxReport(report))
  code = report.status === "READY" ? 0 : 1
} catch {
  // Never echo the error: it could carry configuration.
  console.error("Sandbox acceptance command failed internally; nothing was changed.")
} finally {
  await server.close()
}
process.exit(code)
