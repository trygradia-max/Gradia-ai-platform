// Separate opt-in configuration preserves live evals without letting shell flags
// enable provider access in the deterministic test command.
import { defineConfig } from "vitest/config"
import base from "./vitest.config"
export default defineConfig({ ...base, test: { ...base.test, setupFiles: ["./eval/_live-setup.ts"] } })
