import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Eval harness config. Tests live in `eval/`, resolve the app's `@/` alias,
// and run in a node environment. Live (LLM-backed) tests are gated at runtime
// by EVAL_LIVE — see eval/README.md.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./eval/_setup.ts"],
    include: ["eval/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
