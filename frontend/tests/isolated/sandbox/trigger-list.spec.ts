import { expect, test } from "@playwright/test";

import {
  filterTriggers,
  triggerStatusCounts,
} from "../../../src/components/systems/sandbox/components/trigger-list";
import { triggerStatusWord } from "../../../src/components/systems/sandbox/components/trigger-flow";
import type { SandboxTrigger } from "../../../src/components/systems/sandbox/domain/document";

// The Triggers list (docs/specs/sandbox-relayout.md S6, S7): every row and
// the Status row say On or Off, and the All, On, and Off quick filters count
// the whole list while the search narrows only the rows.

function trigger(
  id: string,
  name: string,
  enabled: boolean,
  kind: "record-created" | "schedule" = "record-created",
): SandboxTrigger {
  return {
    id,
    name,
    enabled,
    priority: 0,
    trigger:
      kind === "schedule"
        ? {
            kind: "schedule",
            moduleId: "requests",
            frequency: "daily",
            time: "09:00",
          }
        : { kind: "record-created", moduleId: "requests" },
    conditionGroup: { operator: "all", conditions: [] },
    actions: [],
  };
}

const triggers = [
  trigger("urgent", "Urgent request alert", true),
  trigger("weekly", "Weekly maintenance review", false, "schedule"),
  trigger("invoices", "Review large invoices", true),
  trigger("untitled", "", false),
];

test("a trigger's state is the word On or Off", () => {
  expect(triggerStatusWord(true)).toBe("On");
  expect(triggerStatusWord(false)).toBe("Off");
});

test("the quick filters count every trigger, whatever the search", () => {
  expect(triggerStatusCounts(triggers)).toEqual({ all: 4, on: 2, off: 2 });
});

test("On and Off show only the triggers in that state", () => {
  const ids = (status: "all" | "on" | "off") =>
    filterTriggers(triggers, { query: "", status }).map((item) => item.id);
  expect(ids("all")).toEqual(["urgent", "weekly", "invoices", "untitled"]);
  expect(ids("on")).toEqual(["urgent", "invoices"]);
  expect(ids("off")).toEqual(["weekly", "untitled"]);
});

test("the search matches the shown name or the event word, ignoring case and spaces", () => {
  const ids = (query: string, status: "all" | "on" | "off" = "all") =>
    filterTriggers(triggers, { query, status }).map((item) => item.id);
  expect(ids("  REVIEW ")).toEqual(["weekly", "invoices"]);
  expect(ids("review", "off")).toEqual(["weekly"]);
  expect(ids("schedule")).toEqual(["weekly"]);
  // A trigger with no name shows, and is found, as "Untitled trigger".
  expect(ids("untitled")).toEqual(["untitled"]);
  expect(ids("no such trigger")).toEqual([]);
});
