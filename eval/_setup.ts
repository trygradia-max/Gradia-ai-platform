import { readFileSync } from "node:fs"

// Vitest setup: load .env.local into process.env so live tests can reach
// ANTHROPIC_API_KEY / OPENAI_API_KEY without a separate --env-file flag.
// Best-effort — the pure (Tier 1) tests don't need any of it.
try {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of txt.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue
    const eq = line.indexOf("=")
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // Strip surrounding quotes, matching `node --env-file` behavior. An
    // empty quoted value ("") stays unset so tests can supply dummies.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (key && val && !(key in process.env)) process.env[key] = val
  }
} catch {
  // no .env.local — fine; live tests will self-skip without a key
}
