import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import playwright from "eslint-plugin-playwright";

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
    // Test-quality guards. Only rules with zero current violations are on;
    // the rest are listed in item 10 of docs/plans/test-suite-tier-2-5.md and join this
    // list as their existing sites are fixed.
    files: ["tests/**/*.ts"],
    plugins: { playwright },
    rules: {
      "playwright/missing-playwright-await": "error",
      "playwright/no-commented-out-tests": "error",
      "playwright/no-element-handle": "error",
      "playwright/no-eval": "error",
      "playwright/no-focused-test": "error",
      "playwright/no-identical-title": "error",
      "playwright/no-nested-step": "error",
      "playwright/no-networkidle": "error",
      "playwright/no-page-pause": "error",
      "playwright/no-unsafe-references": "error",
      "playwright/no-unused-locators": "error",
      "playwright/no-useless-await": "error",
      "playwright/no-wait-for-navigation": "error",
      "playwright/no-wait-for-selector": "error",
      "playwright/valid-expect": "error",
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
