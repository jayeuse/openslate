import type { SandboxTestRun } from "../state/api";
import type { SandboxAutomation, SandboxDocumentDesign } from "./document";

/**
 * Why a stored Test result may no longer describe the draft: the draft has
 * changed since the run, or the module it tested is gone or closed.
 */
export type TestRunStaleness = "older-draft" | "module-gone" | null;

export type TestIssueSubject = {
  kind: "automation" | "field" | "module";
  id: string;
  name: string;
};

export type TestIssueGroup = {
  key: string;
  code: string;
  message: string;
  count: number;
  subject: TestIssueSubject | null;
};

export type TestRunSummary = {
  stale: TestRunStaleness;
  issues: TestIssueGroup[];
};

/**
 * The Test engine reports each issue with a code, a message, and one target
 * id. The same message can repeat for every action it touches, so repeats
 * collapse into one line with a count, and the target id is resolved to the
 * automation, field (in the tested module), or module it names.
 */
export function summarizeTestRun(
  run: SandboxTestRun,
  design: SandboxDocumentDesign,
  automations: readonly SandboxAutomation[],
  draftRevision: number,
): TestRunSummary {
  // Field names resolve even when the module is closed; only staleness
  // cares whether it is still open.
  const testedModule = design.modules.find(
    (item) => item.id === run.input.moduleId,
  );
  const stale: TestRunStaleness =
    !testedModule || testedModule.closed
      ? "module-gone"
      : run.documentRevision !== draftRevision
        ? "older-draft"
        : null;

  const subjectOf = (targetId: string | null): TestIssueSubject | null => {
    if (targetId === null) return null;
    const automation = automations.find((item) => item.id === targetId);
    if (automation)
      return { kind: "automation", id: targetId, name: automation.name };
    const field = testedModule?.fields.find((item) => item.id === targetId);
    if (field) return { kind: "field", id: targetId, name: field.name };
    const named = design.modules.find((item) => item.id === targetId);
    if (named) return { kind: "module", id: targetId, name: named.name };
    return null;
  };

  const groups = new Map<string, TestIssueGroup>();
  for (const issue of run.result.issues) {
    // Issues about the same named thing stay apart per target; issues whose
    // target no longer resolves read the same, so they collapse by message.
    const subject = subjectOf(issue.targetId);
    const key = `${issue.code}\u0000${subject?.id ?? ""}\u0000${issue.message}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else
      groups.set(key, {
        key,
        code: issue.code,
        message: issue.message,
        count: 1,
        subject,
      });
  }
  return { stale, issues: [...groups.values()] };
}
