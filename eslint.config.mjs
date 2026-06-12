import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Locked architectural principle #8: all vendor calls go through provider
  // seams. lib/vapi.ts is the Vapi implementation detail behind
  // lib/voice-provider.ts — nothing else may import it. (Twilio's seam is
  // telephony-provider.ts; its legacy call sites migrate as they're
  // touched, so it isn't restricted yet.)
  {
    files: ["src/**/*.{ts,tsx}", "eval/**/*.{ts,tsx}"],
    ignores: ["src/lib/voice-provider.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/vapi",
              message:
                "Vapi is vendor detail behind the seam — import from @/lib/voice-provider instead (locked principle #8).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The /marketing app is a separate Next.js project with its own
    // tsconfig + lint config. The root scan should ignore it so its
    // findings don't block product-app commits.
    "marketing/**",
  ]),
]);

export default eslintConfig;
