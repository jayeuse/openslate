import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import playwright from "eslint-plugin-playwright";
import fieldPartsInRoot from "./eslint-rules/field-parts-in-root.mts";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Async resource loaders update state after the request resolves.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/exhaustive-deps": "off",
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    // Base UI throws at render for a Field part without a Field root; this
    // catches it at edit time (tests/isolated/eslint/field-parts-in-root.spec.ts).
    files: ["src/**/*.tsx"],
    plugins: {
      openslate: { rules: { "field-parts-in-root": fieldPartsInRoot } },
    },
    rules: { "openslate/field-parts-in-root": "error" },
  },
  {
    // Test-quality guards from item 10 of docs/plans/test-suite-tier-2-5.md.
    // Each rule is on with zero violations.
    files: ["tests/**/*.ts"],
    plugins: { playwright },
    rules: {
      // openMalformedRetentionPolicy (access-security.spec.ts) asserts the
      // refused policy itself; each malformed case only calls it.
      "playwright/expect-expect": [
        "error",
        { assertFunctionNames: ["openMalformedRetentionPolicy"] },
      ],
      "playwright/missing-playwright-await": "error",
      "playwright/no-commented-out-tests": "error",
      "playwright/no-element-handle": "error",
      "playwright/no-eval": "error",
      "playwright/no-focused-test": "error",
      "playwright/no-force-option": "error",
      "playwright/no-identical-title": "error",
      "playwright/no-nested-step": "error",
      "playwright/no-networkidle": "error",
      "playwright/no-page-pause": "error",
      "playwright/no-skipped-test": "error",
      "playwright/no-standalone-expect": "error",
      "playwright/no-unsafe-references": "error",
      "playwright/no-unused-locators": "error",
      "playwright/no-useless-await": "error",
      "playwright/no-useless-not": "error",
      "playwright/no-wait-for-navigation": "error",
      "playwright/no-wait-for-selector": "error",
      "playwright/no-wait-for-timeout": "error",
      "playwright/prefer-web-first-assertions": "error",
      "playwright/valid-expect": "error",
      "playwright/valid-title": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
