import { expect, test } from "@playwright/test";
import { createElement } from "react";

import {
  AdvancedSection,
  readAdvancedOpen,
  writeAdvancedOpen,
} from "../../../src/components/ui/advanced-section";
import { Button } from "../../../src/components/ui/button";
import { DisabledReason } from "../../../src/components/ui/disabled-reason";
import { staticMarkup } from "../sandbox/static-markup";

// The shared parts behind the Advanced Last and Four Moments rules
// (DESIGN.md). Journeys that use them live with each Sandbox section.

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("an Advanced block starts closed and counts what is set inside it", () => {
  const markup = staticMarkup(AdvancedSection, {
    storageKey: "sandbox.module",
    setCount: 2,
    children: "Title field",
  });
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("Advanced");
  expect(markup).toContain("· 2 set");
  // The content stays mounted but hidden, so nothing inside resets on open.
  expect(markup).toMatch(
    /<div[^>]*hidden=""[^>]*data-slot="collapsible-content"[^>]*>Title field</,
  );
});

test("an Advanced block with nothing set shows no count", () => {
  const markup = staticMarkup(AdvancedSection, {
    storageKey: "sandbox.module",
    children: "Title field",
  });
  expect(markup).not.toMatch(/\d+ set/);
});

test("each viewer's Advanced state is remembered per panel", () => {
  const storage = memoryStorage();
  expect(readAdvancedOpen("sandbox.module", storage)).toBe(false);
  writeAdvancedOpen("sandbox.module", true, storage);
  expect(readAdvancedOpen("sandbox.module", storage)).toBe(true);
  expect(readAdvancedOpen("sandbox.department", storage)).toBe(false);
  writeAdvancedOpen("sandbox.module", false, storage);
  expect(readAdvancedOpen("sandbox.module", storage)).toBe(false);
});

test("blocked storage keeps an Advanced block closed", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(readAdvancedOpen("sandbox.module", blocked)).toBe(false);
  expect(() =>
    writeAdvancedOpen("sandbox.module", true, blocked),
  ).not.toThrow();
});

test("a pending button locks, says what it is doing, and keeps its name", () => {
  const idle = staticMarkup(Button, {
    pendingLabel: "Saving…",
    children: "Save triggers",
  });
  expect(idle).not.toContain("aria-busy");
  expect(idle).not.toContain(' disabled=""');
  const busy = staticMarkup(Button, {
    pending: true,
    pendingLabel: "Saving…",
    children: "Save triggers",
  });
  expect(busy).toContain('aria-busy="true"');
  expect(busy).toContain(' disabled=""');
  // Both labels stay in the layout; the hidden one is invisible, so the
  // width holds and only the shown label is read.
  expect(busy).toMatch(/class="[^"]*invisible[^"]*">Save triggers/);
  expect(busy).toContain("Saving…");
});

test("a button without a pending label renders as before", () => {
  expect(staticMarkup(Button, { children: "Fit" })).toBe(
    staticMarkup(Button, { children: "Fit" }),
  );
  expect(staticMarkup(Button, { children: "Fit" })).not.toContain("grid");
});

test("a disabled control with a reason stays focusable and says why", () => {
  const markup = staticMarkup(DisabledReason, {
    reason: "Choose a module first.",
    children: createElement(Button, { disabled: true }, "Run test"),
  });
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).not.toMatch(/<button[^>]* disabled=""/);
  const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1];
  // The description id is a real, non-empty id.
  expect(describedBy).toMatch(/\S/);
  expect(markup).toContain(`id="${describedBy}"`);
  expect(markup).toContain("Choose a module first.");
});

test("a control without a reason is unchanged", () => {
  const plain = staticMarkup(Button, { children: "Run test" });
  expect(
    staticMarkup(DisabledReason, {
      reason: null,
      children: createElement(Button, null, "Run test"),
    }),
  ).toBe(plain);
});
