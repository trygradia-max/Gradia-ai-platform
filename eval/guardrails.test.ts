import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

import {
  ALWAYS_HITL,
  isAutonomyAllowed,
  resolveAgentMode,
} from "@/lib/autonomy"
import type { PendingActionType, ShopRow } from "@/lib/types/database"

/**
 * Tier 1 — pure, deterministic, no API. These encode the safety properties
 * that must never silently regress, and they run on every change (`npm test`).
 */

describe("HITL floor — money & calendar actions are always human-approved", () => {
  it("book_appointment and charge_customer are never auto-executable", () => {
    expect(isAutonomyAllowed("book_appointment")).toBe(false)
    expect(isAutonomyAllowed("charge_customer")).toBe(false)
    expect(ALWAYS_HITL.has("book_appointment")).toBe(true)
    expect(ALWAYS_HITL.has("charge_customer")).toBe(true)
  })

  it("lower-stakes actions remain automatable (so the floor is a floor, not a wall)", () => {
    const automatable: PendingActionType[] = [
      "create_lead",
      "add_note",
      "send_sms",
    ]
    for (const t of automatable) {
      expect(isAutonomyAllowed(t), `${t} should be automatable`).toBe(true)
    }
  })

  it("the floor holds even when the agent's mode is fully autonomous", () => {
    // resolveAgentMode can say "autonomous", but isAutonomyAllowed is the
    // per-action gate the runtime ANDs against — so book/charge still stage.
    const autonomousShop = {
      settings: { autonomy: { default: "autonomous", overrides: {} } },
    } as unknown as Pick<ShopRow, "settings">

    expect(resolveAgentMode(autonomousShop, "any-agent")).toBe("autonomous")
    for (const t of ["book_appointment", "charge_customer"] as PendingActionType[]) {
      const wouldAutoExecute =
        resolveAgentMode(autonomousShop, "any-agent") === "autonomous" &&
        isAutonomyAllowed(t)
      expect(wouldAutoExecute, `${t} must not auto-execute`).toBe(false)
    }
  })
})

describe("autonomy resolution — safe defaults & override precedence", () => {
  it("defaults to suggest (HITL) when nothing is configured", () => {
    expect(resolveAgentMode(null, "x")).toBe("suggest")
    expect(resolveAgentMode({ settings: {} } as Pick<ShopRow, "settings">, "x")).toBe(
      "suggest"
    )
  })

  it("per-agent override beats the global default", () => {
    const shop = {
      settings: {
        autonomy: { default: "suggest", overrides: { reminder: "autonomous" } },
      },
    } as unknown as Pick<ShopRow, "settings">
    expect(resolveAgentMode(shop, "reminder")).toBe("autonomous")
    expect(resolveAgentMode(shop, "other")).toBe("suggest")
  })
})

describe("BI agent is read-only at the source level", () => {
  // Complements the runtime check in bi.eval.test.ts: this scans the source so
  // a write call can't sneak into the BI tool layer even without a live run.
  it("bi-tools.ts contains no write operations", () => {
    const url = new URL("../src/lib/bi-tools.ts", import.meta.url)
    const src = readFileSync(url, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
      .replace(/\/\/.*$/gm, "") // strip line comments

    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(src, `read-only violation: found ${op} in bi-tools.ts`).not.toContain(
        op
      )
    }
  })
})
