import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

import {
  ALWAYS_HITL,
  isAutonomyAllowed,
  resolveAgentMode,
} from "@/lib/autonomy"
import { GRADIA_VOICE } from "@/lib/persona"
import type { PendingActionType, ShopRow } from "@/lib/types/database"

/**
 * Tier 1 — pure, deterministic, no API. These encode the safety properties
 * that must never silently regress, and they run on every change (`npm test`).
 */

describe("HITL floor — money & calendar actions are always human-approved", () => {
  it("book_appointment and calendar writes are never auto-executable", () => {
    expect(isAutonomyAllowed("book_appointment")).toBe(false)
    expect(isAutonomyAllowed("reschedule_appointment")).toBe(false)
    expect(isAutonomyAllowed("cancel_appointment")).toBe(false)
    expect(ALWAYS_HITL.has("book_appointment")).toBe(true)
    expect(ALWAYS_HITL.has("reschedule_appointment")).toBe(true)
    expect(ALWAYS_HITL.has("cancel_appointment")).toBe(true)
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
    // Autonomy resolves only for Package 2 (active plan + voice add-on) —
    // see the entitlement-gating suite below.
    const autonomousShop = {
      settings: { autonomy: { default: "autonomous", overrides: {} } },
      plan: "active",
      voice_addon: true,
    } as unknown as Pick<ShopRow, "settings" | "plan" | "voice_addon">

    expect(resolveAgentMode(autonomousShop, "any-agent")).toBe("autonomous")
    for (const t of ["book_appointment", "reschedule_appointment", "cancel_appointment"] as PendingActionType[]) {
      const wouldAutoExecute =
        resolveAgentMode(autonomousShop, "any-agent") === "autonomous" &&
        isAutonomyAllowed(t)
      expect(wouldAutoExecute, `${t} must not auto-execute`).toBe(false)
    }
  })
})

describe("autonomy resolution — safe defaults & override precedence", () => {
  // All cases here are Package 2 shops (active + voice add-on); the
  // entitlement gate itself is locked in the suite below.
  const pkg2 = (settings: unknown) =>
    ({ settings, plan: "active", voice_addon: true }) as unknown as Pick<
      ShopRow,
      "settings" | "plan" | "voice_addon"
    >

  it("defaults to suggest (HITL) when nothing is configured", () => {
    expect(resolveAgentMode(null, "x")).toBe("suggest")
    expect(resolveAgentMode(pkg2({}), "x")).toBe("suggest")
  })

  it("per-agent override beats the global default", () => {
    const shop = pkg2({
      autonomy: { default: "suggest", overrides: { reminder: "autonomous" } },
    })
    expect(resolveAgentMode(shop, "reminder")).toBe("autonomous")
    expect(resolveAgentMode(shop, "other")).toBe("suggest")
  })
})

describe("autonomy is gated by Package 2 (active plan + voice add-on)", () => {
  // The trust dial is a code guardrail: autonomous mode is a Package 2
  // capability, so the runtime forces "suggest" without the entitlement no
  // matter what the shop stored. Free/past_due get nothing (no free packages).
  const autonomousSettings = { autonomy: { default: "autonomous", overrides: {} } }
  const mk = (plan: ShopRow["plan"], voice_addon: boolean) =>
    ({ settings: autonomousSettings, plan, voice_addon }) as unknown as Pick<
      ShopRow,
      "settings" | "plan" | "voice_addon"
    >

  it("Core (active, no add-on) is forced to suggest even when set autonomous", () => {
    expect(resolveAgentMode(mk("active", false), "any")).toBe("suggest")
  })

  it("free or past_due with the add-on flag is still suggest (fail-closed)", () => {
    expect(resolveAgentMode(mk("free", true), "any")).toBe("suggest")
    expect(resolveAgentMode(mk("past_due", true), "any")).toBe("suggest")
  })

  it("Package 2 (active + voice add-on) unlocks autonomous", () => {
    expect(resolveAgentMode(mk("active", true), "any")).toBe("autonomous")
  })
})

describe("canonical voice — strictly we/us, never first-person singular", () => {
  // persona.ts is the single source the drafters + voice + chat compose. Lock
  // the strict rule here so it can't be silently weakened back to "never I"
  // (which lets "me"/"my" slip through).
  it('GRADIA_VOICE forbids "I", "me", and "my"', () => {
    expect(GRADIA_VOICE).toMatch(/never/i)
    for (const pronoun of ['"I"', '"me"', '"my"']) {
      expect(GRADIA_VOICE, `canonical voice must forbid ${pronoun}`).toContain(
        pronoun
      )
    }
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
