import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "out-mobile/**", "out-desktop/**", "node_modules/**", "eslint.config.mjs"]),
  {
    // A leading underscore is this repo's way of saying "this binding exists
    // to satisfy a signature, and is deliberately not read" — a mock whose
    // shape must match the real call, a destructured field being dropped.
    // The rule stays on for every other name.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // `no-assign-module-variable` is about Next's build output, which a
      // Vitest file is never part of: `native-session.test.ts` assigns a local
      // named `module` to stand in for a dynamically imported one.
      "@next/next/no-assign-module-variable": "off",
      // Test probes record what a render saw into module scope on purpose —
      // a render counter, the last value a hook returned — which is the whole
      // mechanism by which the test can assert on it.
      "react-hooks/globals": "off",
    },
  },
]);

export default config;
