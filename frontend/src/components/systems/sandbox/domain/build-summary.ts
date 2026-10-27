import type { Design } from "./model";
import type { SandboxValidationIssue } from "./validation-types";

// Build with nothing selected (docs/specs/sandbox-relayout.md S12): what the
// design needs, in the Access "Needs attention" grammar, from data the page
// already has. Each row has one action, which the Designer runs by its kind.

export type BuildAttentionKind =
  "unpublished" | "triggersOff" | "emptyModules" | "overlaps" | "issue";

export type BuildAttentionItem = {
  /** Stable across renders, for the row key. */
  key: string;
  kind: BuildAttentionKind;
  /** Shown bold before the text; null when the text carries no count. */
  count: number | null;
  /** The words after the count, matched to it. */
  text: string;
  /** The action's one word (or short phrase). */
  verb: string;
  tone: "warn" | "info";
  /** The first trigger that is off, or the first module with no fields. */
  target: string | null;
  /** The publish blocker an issue row opens. */
  issue: SandboxValidationIssue | null;
};

/** A publish blocker as the page words it, with the action that opens it. */
export type BuildAttentionIssue = {
  key: string;
  message: string;
  verb: string;
  issue: SandboxValidationIssue;
};

const counted = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/**
 * The rows, in this order: unpublished changes, triggers that are off,
 * modules with no fields, overlapping frames or tables, then each publish
 * blocker. A design with none of these has no rows ("All clear").
 */
export function buildAttentionItems({
  design,
  unpublished,
  overlapping,
  issues,
}: {
  design: Pick<Design, "modules" | "rules">;
  unpublished: boolean;
  overlapping: boolean;
  issues: readonly BuildAttentionIssue[];
}): BuildAttentionItem[] {
  const items: BuildAttentionItem[] = [];
  if (unpublished)
    items.push({
      key: "unpublished",
      kind: "unpublished",
      count: null,
      text: "Unpublished changes",
      verb: "Review",
      tone: "info",
      target: null,
      issue: null,
    });
  const off = design.rules.filter((rule) => !rule.enabled);
  if (off.length)
    items.push({
      key: "triggersOff",
      kind: "triggersOff",
      count: off.length,
      text: counted(off.length, "trigger is off", "triggers are off"),
      verb: "Show",
      tone: "info",
      target: off[0]!.id,
      issue: null,
    });
  const empty = design.modules.filter((item) => item.fields.length === 0);
  if (empty.length)
    items.push({
      key: "emptyModules",
      kind: "emptyModules",
      count: empty.length,
      text: counted(
        empty.length,
        "module has no fields",
        "modules have no fields",
      ),
      verb: "Show",
      tone: "warn",
      target: empty[0]!.id,
      issue: null,
    });
  if (overlapping)
    items.push({
      key: "overlaps",
      kind: "overlaps",
      count: null,
      text: "Departments or modules overlap",
      verb: "Auto-arrange",
      tone: "info",
      target: null,
      issue: null,
    });
  for (const issue of issues)
    items.push({
      key: `issue:${issue.key}`,
      kind: "issue",
      count: null,
      text: issue.message,
      verb: issue.verb,
      tone: "warn",
      target: null,
      issue: issue.issue,
    });
  return items;
}

type Lifecycle = { closed: boolean; canPurge: boolean };

function lifecycleWords({ closed, canPurge }: Lifecycle): string[] {
  return [
    closed ? "Reopen" : "Close",
    "Delete",
    ...(canPurge ? ["Delete forever"] : []),
  ];
}

/** A setting's name, marked "(set)" when it holds a value that is not its default. */
const setting = (name: string, set: boolean) => (set ? `${name} (set)` : name);

/**
 * What a closed Advanced block in Properties holds, by the names of its rows
 * and buttons (F7): the module's Department and Title field, then the
 * lifecycle actions that apply now. A setting with a value that is not its
 * default says "(set)", so nothing changes out of sight; an action never
 * does. A module always has a department, so Department is never "set".
 */
export function propertiesAdvancedSummary(
  kind: "module" | "department",
  lifecycle: Lifecycle,
  set: { titleField?: boolean } = {},
): string {
  return [
    ...(kind === "module"
      ? ["Department", setting("Title field", set.titleField === true)]
      : []),
    ...lifecycleWords(lifecycle),
  ].join(", ");
}

const LIMITED_TYPES = new Set([
  "Text",
  "Long text",
  "Email",
  "URL",
  "Number",
  "Integer",
  "Date",
  "Date/Time",
]);

/**
 * What a field's closed Advanced block holds: Description, a Default unless
 * the type has none (User), Limits for the types that take them, then the
 * lifecycle actions that apply now. Each setting with a value says "(set)".
 */
export function fieldAdvancedSummary(
  type: string,
  lifecycle: Lifecycle,
  set: { description: boolean; defaultValue: boolean; limits: boolean } = {
    description: false,
    defaultValue: false,
    limits: false,
  },
): string {
  return [
    setting("Description", set.description),
    ...(type === "User" ? [] : [setting("Default", set.defaultValue)]),
    ...(LIMITED_TYPES.has(type) ? [setting("Limits", set.limits)] : []),
    ...lifecycleWords(lifecycle),
  ].join(", ");
}

/**
 * The header's attention control (S18): how many items need attention, in
 * a few words, or null when none do and the control is absent.
 */
export function attentionCountLabel(count: number): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? "needs" : "need"} attention`;
}
