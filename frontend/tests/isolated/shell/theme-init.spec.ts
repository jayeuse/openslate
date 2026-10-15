import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import { expect, test } from "@playwright/test";

// The prepaint script in public/theme-init.js applies the stored color mode
// (System follows the OS), reduced motion, device text size and density, and
// the organization look before the page hydrates; unknown or unreadable
// storage falls back to the defaults. The http journey "public prepaint
// resolves System and device text before hydration including blocked
// storage" keeps one run with page JavaScript aborted to prove the script is
// in the document head.

type Root = {
  dark: boolean | undefined;
  dataset: Record<string, string>;
};

function prepaint(
  stored: Record<string, string> | "blocked",
  osDark: boolean | null,
): Root {
  const root: Root = { dark: undefined, dataset: { motion: "reduced" } };
  const context = createContext({
    crypto: { randomUUID: () => "native", getRandomValues: () => undefined },
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, force: boolean) => {
            if (name === "dark") root.dark = force;
          },
        },
        dataset: root.dataset,
      },
    },
    localStorage: {
      getItem: (key: string) => {
        if (stored === "blocked") throw new Error("Storage is blocked");
        return stored[key] ?? null;
      },
    },
    ...(osDark === null
      ? {}
      : {
          matchMedia: (query: string) => ({
            matches: query === "(prefers-color-scheme: dark)" && osDark,
          }),
        }),
  });
  runInContext(
    readFileSync(resolve(process.cwd(), "public", "theme-init.js"), "utf8"),
    context,
  );
  return root;
}

const defaults = { textSize: "100", density: "default" };

const cases: {
  name: string;
  stored: Record<string, string> | "blocked";
  osDark: boolean | null;
  dark: boolean;
  dataset: Record<string, string>;
}[] = [
  {
    name: "no stored choice on a dark OS",
    stored: {},
    osDark: true,
    dark: true,
    dataset: defaults,
  },
  {
    name: "System on a light OS",
    stored: { "openslate-theme": "system" },
    osDark: false,
    dark: false,
    dataset: defaults,
  },
  {
    name: "System without matchMedia",
    stored: { "openslate-theme": "system" },
    osDark: null,
    dark: false,
    dataset: defaults,
  },
  {
    name: "Light on a dark OS",
    stored: { "openslate-theme": "light" },
    osDark: true,
    dark: false,
    dataset: defaults,
  },
  {
    name: "Dark on a light OS",
    stored: { "openslate-theme": "dark" },
    osDark: false,
    dark: true,
    dataset: defaults,
  },
  {
    name: "an unknown color mode on a dark OS",
    stored: { "openslate-theme": "sepia" },
    osDark: true,
    dark: true,
    dataset: defaults,
  },
  {
    name: "reduced motion, 125% text, spacious density and Stockroom",
    stored: {
      "openslate-motion": "reduced",
      "openslate-text-size": "125",
      "openslate-density": "spacious",
      "openslate-org-theme": "stockroom",
    },
    osDark: false,
    dark: false,
    dataset: {
      motion: "reduced",
      textSize: "125",
      density: "spacious",
      theme: "stockroom",
    },
  },
  {
    name: "112.5% text, compact density and Whiteboard",
    stored: {
      "openslate-text-size": "112.5",
      "openslate-density": "compact",
      "openslate-org-theme": "whiteboard",
    },
    osDark: false,
    dark: false,
    dataset: { textSize: "112.5", density: "compact", theme: "whiteboard" },
  },
  {
    name: "unknown motion, text size, density and look",
    stored: {
      "openslate-motion": "full",
      "openslate-text-size": "150",
      "openslate-density": "tight",
      "openslate-org-theme": "sepia",
    },
    osDark: false,
    dark: false,
    dataset: defaults,
  },
  {
    name: "the Slate look",
    stored: { "openslate-org-theme": "slate" },
    osDark: false,
    dark: false,
    dataset: defaults,
  },
  {
    name: "blocked storage on a dark OS",
    stored: "blocked",
    osDark: true,
    dark: true,
    dataset: defaults,
  },
];

for (const row of cases)
  test(`prepaint with ${row.name}`, () => {
    const root = prepaint(row.stored, row.osDark);
    expect(root.dark).toBe(row.dark);
    expect(root.dataset).toEqual(row.dataset);
  });
