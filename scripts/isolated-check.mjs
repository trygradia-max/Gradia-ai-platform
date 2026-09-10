// macOS execution boundary: empty environment + OS-level provider egress denial.
// Dependencies/runtime must already be installed. Never falls back to an unsafe run.
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
const mode = process.argv[2]
const commands = {
  unit: ["node_modules/vitest/vitest.mjs", "run", "--exclude", "**/*.eval.test.ts", "--exclude", "**/integration/**"],
  integration: ["node_modules/vitest/vitest.mjs", "run", "--fileParallelism=false", "eval/integration"],
  lint: ["node_modules/eslint/bin/eslint.js"],
  types: ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"],
  build: ["node_modules/next/dist/bin/next", "build", "--webpack"],
}
if (!commands[mode] || process.platform !== "darwin") throw new Error("Use an explicitly isolated runner for this platform")
if (readdirSync(".").some(name => name.startsWith(".env") && name !== ".env.example")) throw new Error("Application environment files are forbidden in isolated checks")
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: resolve(".local-tools"), TMPDIR: process.env.TMPDIR || "/tmp", NEXT_TELEMETRY_DISABLED: "1", EVAL_LIVE: "0", CI: "1" }
if (mode === "build") env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = resolve("scripts/offline-fonts.cjs")
let allow = ""
if (mode === "integration") {
  const db = JSON.parse(readFileSync(".local-tools/test-db.json", "utf8"))
  if (db.API_URL !== "http://127.0.0.1:56531" || !db.SERVICE_ROLE_KEY || !db.ANON_KEY) throw new Error("Invalid isolated DB configuration")
  Object.assign(env, { INTEGRATION: "1", GRADIA_DISPOSABLE_TEST: "gradia-isolated-tests", SUPABASE_TEST_URL: db.API_URL, SUPABASE_TEST_SERVICE_ROLE_KEY: db.SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY: db.SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY: db.ANON_KEY })
  allow = '(allow network-outbound (remote ip "localhost:56531"))'
}
if (mode === "integration" && process.argv.slice(3).some(arg => arg.endsWith(".test.ts"))) commands.integration.pop()
const policy = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote unix-socket))${allow}`
const result = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, process.execPath, ...commands[mode], ...process.argv.slice(3)], { env, stdio: "inherit" })
if (result.error) throw result.error
process.exit(result.status ?? 1)
