import { expect, test } from "@playwright/test";

import {
  applyDeviceAppearancePreferences,
  persistAppearancePreferences,
  persistDeviceAppearancePreferences,
  readAppearancePreferences,
  readDeviceAppearancePreferences,
} from "../../src/lib/appearance-preferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

test("reduce motion is off unless this browser chose it", () => {
  expect(readAppearancePreferences(memoryStorage()).reduceMotion).toBe(false);
  expect(
    readAppearancePreferences(memoryStorage({ "openslate-motion": "reduced" }))
      .reduceMotion,
  ).toBe(true);
  expect(
    readAppearancePreferences(memoryStorage({ "openslate-motion": "full" }))
      .reduceMotion,
  ).toBe(false);
});

test("turning reduce motion off removes the stored choice", () => {
  const storage = memoryStorage();
  persistAppearancePreferences({ mode: "dark", reduceMotion: true }, storage);
  expect(storage.values.get("openslate-motion")).toBe("reduced");
  persistAppearancePreferences({ mode: "dark", reduceMotion: false }, storage);
  expect(storage.values.has("openslate-motion")).toBe(false);
  expect(storage.values.get("openslate-theme")).toBe("dark");
});

// Device text size and density live in this browser only. The http journeys
// "device text and density scale pages without changing account preferences"
// and "blocked device storage still applies text and spacing without claiming
// persistence" keep the rendered result.
const deviceReads: {
  name: string;
  storage: Pick<Storage, "getItem"> | null;
  result: { textSize: string; density: string };
}[] = [
  {
    name: "stored 125% text and spacious density",
    storage: memoryStorage({
      "openslate-text-size": "125",
      "openslate-density": "spacious",
    }),
    result: { textSize: "125", density: "spacious" },
  },
  {
    name: "stored 112.5% text and compact density",
    storage: memoryStorage({
      "openslate-text-size": "112.5",
      "openslate-density": "compact",
    }),
    result: { textSize: "112.5", density: "compact" },
  },
  {
    name: "unknown stored values",
    storage: memoryStorage({
      "openslate-text-size": "150",
      "openslate-density": "tight",
    }),
    result: { textSize: "100", density: "default" },
  },
  {
    name: "no storage",
    storage: null,
    result: { textSize: "100", density: "default" },
  },
  {
    name: "storage that throws",
    storage: {
      getItem: () => {
        throw new Error("Storage is blocked");
      },
    },
    result: { textSize: "100", density: "default" },
  },
];

for (const row of deviceReads)
  test(`device appearance reads ${row.name}`, () => {
    expect(readDeviceAppearancePreferences(row.storage)).toEqual(row.result);
  });

test("device appearance applies text size and density to the page root", () => {
  const root = { dataset: {} as Record<string, string> };
  applyDeviceAppearancePreferences(
    { textSize: "112.5", density: "compact" },
    root as unknown as HTMLElement,
  );
  expect(root.dataset).toEqual({ textSize: "112.5", density: "compact" });
});

for (const blocked of [false, true])
  test(`device appearance ${blocked ? "reports no persistence when storage throws" : "persists both choices"}`, () => {
    const storage = memoryStorage();
    const globals = globalThis as { window?: unknown };
    globals.window = {
      localStorage: blocked
        ? {
            setItem: () => {
              throw new Error("Storage is blocked");
            },
          }
        : storage,
    };
    try {
      expect(
        persistDeviceAppearancePreferences({
          textSize: "125",
          density: "spacious",
        }),
      ).toBe(!blocked);
      expect(Object.fromEntries(storage.values)).toEqual(
        blocked
          ? {}
          : { "openslate-text-size": "125", "openslate-density": "spacious" },
      );
    } finally {
      delete globals.window;
    }
  });
