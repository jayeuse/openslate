import { expect, test } from "@playwright/test";

import {
  persistAppearancePreferences,
  readAppearancePreferences,
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
