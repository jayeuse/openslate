import { canvasFieldId } from "../helpers/bridge";
import type { SandboxValidationIssue } from "./validation-types";

/** Where the Sandbox screen opens a validation issue. */
export type SandboxIssueDestination =
  | { kind: "section"; section: "Build" | "Test" }
  | { kind: "query"; params: URLSearchParams };

/**
 * Routes a validation issue to the section that can fix it: scenario issues to
 * Test, trigger issues and issues on a trigger to Triggers, and structure
 * issues to Build with the entity selected.
 */
export function sandboxIssueDestination(
  issue: SandboxValidationIssue,
  triggerIds: ReadonlySet<string>,
  current: URLSearchParams,
): SandboxIssueDestination {
  if (issue.code.startsWith("scenario."))
    return { kind: "section", section: "Test" };
  if (issue.code.startsWith("trigger.")) {
    const params = new URLSearchParams(current.toString());
    if (issue.targetId) params.set("rule", issue.targetId);
    params.set("section", "triggers");
    return { kind: "query", params };
  }
  if (!issue.targetId) return { kind: "section", section: "Build" };
  const params = new URLSearchParams(current.toString());
  if (triggerIds.has(issue.targetId)) {
    params.set("rule", issue.targetId);
    params.set("section", "triggers");
  } else {
    params.set(
      "inspect",
      issue.moduleId
        ? canvasFieldId(issue.moduleId, issue.targetId)
        : issue.targetId,
    );
    params.set("section", "build");
  }
  return { kind: "query", params };
}
