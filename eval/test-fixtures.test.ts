import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error -- plain ESM script module, no type declarations
import { TEST_FIXTURES } from "../scripts/test-fixtures.mjs"

describe("disposable test fixtures", () => {
  it("every tests/sql fixture is applied by both the CI and the local record-fresh reset", () => {
    const onDisk = readdirSync("tests/sql").filter((f) => f.endsWith(".sql")).map((f) => `tests/sql/${f}`).sort()
    expect([...TEST_FIXTURES].sort()).toEqual(onDisk)
  })
})
