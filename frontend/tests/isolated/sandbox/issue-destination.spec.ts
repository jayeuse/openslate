import { expect, test } from "@playwright/test";

import { sandboxIssueDestination } from "../../../src/components/systems/sandbox/domain/issue-destination";

const issue = (code: string, targetId?: string, moduleId?: string) => ({
  code,
  severity: "error" as const,
  message: code,
  ...(targetId === undefined ? {} : { targetId }),
  ...(moduleId === undefined ? {} : { moduleId }),
});

test("a trigger issue opens the Triggers section on that trigger", () => {
  const destination = sandboxIssueDestination(
    issue("trigger.field_missing", "urgent-alert"),
    new Set(),
    new URLSearchParams("section=build&inspect=orders"),
  );

  expect(destination.kind).toBe("query");
  if (destination.kind !== "query") throw new Error("Expected a query");
  expect(destination.params.get("section")).toBe("triggers");
  expect(destination.params.get("rule")).toBe("urgent-alert");
});

test("a trigger issue without a target still opens the Triggers section", () => {
  const destination = sandboxIssueDestination(
    issue("trigger.module_missing"),
    new Set(),
    new URLSearchParams(),
  );

  expect(destination).toEqual({
    kind: "query",
    params: new URLSearchParams("section=triggers"),
  });
});

test("scenario, structure and trigger-target issues keep their sections", () => {
  expect(
    sandboxIssueDestination(
      issue("scenario.record_missing"),
      new Set(),
      new URLSearchParams(),
    ),
  ).toEqual({ kind: "section", section: "Test" });
  expect(
    sandboxIssueDestination(
      issue("module.name_missing"),
      new Set(),
      new URLSearchParams(),
    ),
  ).toEqual({ kind: "section", section: "Build" });

  const ruleTarget = sandboxIssueDestination(
    issue("design.reference_closed", "urgent-alert"),
    new Set(["urgent-alert"]),
    new URLSearchParams(),
  );
  expect(ruleTarget.kind === "query" && ruleTarget.params.get("section")).toBe(
    "triggers",
  );

  const field = sandboxIssueDestination(
    issue("field.default_invalid", "status", "orders"),
    new Set(),
    new URLSearchParams(),
  );
  expect(field.kind === "query" && field.params.get("section")).toBe("build");
  expect(field.kind === "query" && field.params.get("inspect")).toBeTruthy();
});

// The Triggers quick filter in a link is a one-time request; an issue link
// never carries it, so it cannot hide the trigger it opens.
test("an issue link drops the Triggers filter", () => {
  const current = new URLSearchParams("section=triggers&status=off");
  for (const [found, triggers] of [
    [issue("trigger.field_missing", "urgent-alert"), new Set<string>()],
    [
      issue("design.reference_closed", "urgent-alert"),
      new Set(["urgent-alert"]),
    ],
    [issue("module.name_missing", "orders"), new Set<string>()],
  ] as const) {
    const destination = sandboxIssueDestination(found, triggers, current);
    if (destination.kind !== "query") throw new Error("Expected a query");
    expect(destination.params.get("status"), found.code).toBeNull();
  }
});
