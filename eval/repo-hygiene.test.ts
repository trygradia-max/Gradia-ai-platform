import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

import { describe, it, expect } from "vitest"

/**
 * Tier 1 — repo hygiene. Regression lock for audit finding C-1 (ticket
 * P0-001): a live Postgres superuser connection string was committed inside
 * .gitignore and pushed. These tests must fail if any credential-bearing
 * connection string returns to a tracked file. Runs in `npm test`, so CI
 * greps on every pass (coordinated with P0-002's CI enforcement).
 *
 * Placeholder-safe: template forms like `postgresql://postgres:<password>@…`
 * in docs or .env.example do NOT match — only real userinfo passwords do.
 */

// POSIX ERE for `git grep -E`: scheme, then user:password@ where the password
// segment is real text (a leading `<` marks a placeholder and is excluded).
const CREDENTIAL_URL_ERE =
  "postgres(ql)?://[^[:space:]:@/<]+:[^[:space:]@<]+@"

function git(...args: string[]) {
  return spawnSync("git", args, { encoding: "utf8" })
}

describe("repo hygiene — committed credentials (P0-001 / C-1)", () => {
  it("no tracked file contains a credential-bearing postgres connection string", () => {
    const res = git("grep", "-I", "-l", "-E", CREDENTIAL_URL_ERE, "--", ".")
    // git grep exits 1 when nothing matches (the passing state), 0 on a match.
    if (res.status === 0) {
      expect.fail(
        `credential-shaped connection string found in tracked file(s):\n${res.stdout}`,
      )
    }
    expect(res.status).toBe(1)
  })

  it(".gitignore holds ignore patterns only — no URLs outside comments, no postgres anywhere", () => {
    const lines = readFileSync(".gitignore", "utf8").split("\n")
    // A URL pasted as an "ignore pattern" is exactly how C-1 happened.
    // Comment lines may reference docs URLs; pattern lines may not hold URLs at all.
    const urlPatternLines = lines.filter(
      (line) => !line.trimStart().startsWith("#") && line.includes("://"),
    )
    expect(urlPatternLines).toEqual([])
    // No form of a postgres reference belongs in an ignore file, comment or not.
    expect(lines.filter((line) => line.toLowerCase().includes("postgres"))).toEqual([])
  })
})
