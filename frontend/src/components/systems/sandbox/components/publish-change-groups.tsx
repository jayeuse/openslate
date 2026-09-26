"use client";

import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SandboxPublicationChange } from "../state/api";

type Change = SandboxPublicationChange;
/** The part of the draft needed to place field changes under modules. */
export type PublishReviewDesign = {
  modules: ReadonlyArray<{
    id: string;
    name: string;
    fields: ReadonlyArray<{ id: string }>;
  }>;
};
type Kind = Change["kind"];

const KIND_NOUNS: Record<Kind, readonly [string, string]> = {
  department: ["department", "departments"],
  module: ["module", "modules"],
  field: ["field", "fields"],
  relationship: ["relationship", "relationships"],
  automation: ["automation", "automations"],
};
const KIND_ORDER: readonly Kind[] = [
  "department",
  "module",
  "field",
  "relationship",
  "automation",
];
const ACTION_LABELS: Record<Change["action"], string> = {
  create: "New",
  update: "Changed",
  close: "Closed",
  reopen: "Reopened",
};
// Groups longer than this show a "Show all" control.
const VISIBLE_ROWS = 5;

function counted(count: number, [one, many]: readonly [string, string]) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "14 changes: 6 departments, 1 module, 6 fields, 1 relationship". */
export function publicationChangeSummary(changes: readonly Change[]): string {
  const parts = KIND_ORDER.flatMap((kind) => {
    const count = changes.filter((change) => change.kind === kind).length;
    return count ? [counted(count, KIND_NOUNS[kind])] : [];
  });
  const action = sharedAction(changes);
  const total = counted(changes.length, ["change", "changes"]);
  const scope = action ? `, all ${ACTION_LABELS[action].toLowerCase()}` : "";
  return `${total}${scope}: ${parts.join(", ")}`;
}

/** The one action every change shares, such as a first publish. */
function sharedAction(changes: readonly Change[]): Change["action"] | null {
  const first = changes[0]?.action;
  return first && changes.every((change) => change.action === first)
    ? first
    : null;
}

// When every change shares one action, the summary says it once and rows
// drop their action chips.
const ShowActions = createContext(true);

/**
 * The publication planner names a field change by its module and field
 * (backend `publications/rules.py` `_field_key`). Keys over 1,000 characters
 * are hashed there, so those fields stay in "Other". IDs are ASCII, so
 * `length` matches the planner's character count.
 */
export function publicationFieldKey(moduleId: string, fieldId: string) {
  return `field:raw:${moduleId.length}:${moduleId}:${fieldId}`;
}

type ModuleEntry = {
  id: string;
  name: string;
  change?: Change;
  fields: Change[];
};

/**
 * Sort changes into reading order. Field changes nest under their module
 * when the draft design still holds the field; the rest go to "Other".
 */
export function groupPublicationChanges(
  changes: readonly Change[],
  design: PublishReviewDesign,
) {
  const moduleOfField = new Map(
    design.modules.flatMap((item) =>
      item.fields.map(
        (field) => [publicationFieldKey(item.id, field.id), item] as const,
      ),
    ),
  );
  const modules = new Map<string, ModuleEntry>();
  const other: Change[] = [];
  for (const change of changes) {
    if (change.kind === "module") {
      const entry = modules.get(change.sandboxId);
      if (entry) entry.change = change;
      else
        modules.set(change.sandboxId, {
          id: change.sandboxId,
          name: change.label,
          change,
          fields: [],
        });
    }
    if (change.kind !== "field") continue;
    const owner = moduleOfField.get(change.sandboxId);
    if (!owner) {
      other.push(change);
      continue;
    }
    const entry = modules.get(owner.id) ?? {
      id: owner.id,
      name: owner.name,
      fields: [],
    };
    entry.fields.push(change);
    modules.set(owner.id, entry);
  }
  return {
    departments: changes.filter((change) => change.kind === "department"),
    modules: [...modules.values()],
    relationships: changes.filter((change) => change.kind === "relationship"),
    automations: changes.filter((change) => change.kind === "automation"),
    other,
  };
}

function ChangeRow({ change }: { change: Change }) {
  if (!useContext(ShowActions))
    return <span className="min-w-0 break-words">{change.label}</span>;
  return (
    <>
      <Badge
        variant={change.action === "close" ? "warning" : "outline"}
        className="w-20 shrink-0 justify-center"
      >
        {ACTION_LABELS[change.action]}
      </Badge>
      <span className="min-w-0 break-words">{change.label}</span>
    </>
  );
}

function ChangeGroup<T>({
  title,
  noun,
  items,
  render,
  itemKey,
}: {
  title: string;
  noun: readonly [string, string];
  items: readonly T[];
  render: (item: T) => ReactNode;
  itemKey: (item: T) => string;
}) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, VISIBLE_ROWS);
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h4 id={headingId} className="text-sm font-medium">
        {title}
      </h4>
      <ul className="grid gap-1.5 text-sm">
        {shown.map((item) => (
          <li key={itemKey(item)} className="grid gap-1.5">
            {render(item)}
          </li>
        ))}
      </ul>
      {items.length > VISIBLE_ROWS ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : `Show all ${counted(items.length, noun)}`}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * One module row. Its field changes start collapsed, so "Show all" on the
 * Modules group shortens the review as much as it does in other groups.
 */
function ModuleChanges({ entry }: { entry: ModuleEntry }) {
  const showActions = useContext(ShowActions);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const fieldCount = counted(entry.fields.length, KIND_NOUNS.field);
  return (
    <>
      <div className="flex items-center gap-2">
        {entry.change ? (
          <ChangeRow change={entry.change} />
        ) : (
          <>
            {showActions ? (
              <span className="text-muted-foreground w-20 shrink-0 text-center text-xs leading-5">
                Unchanged
              </span>
            ) : null}
            <span className="min-w-0 flex-1 break-words">{entry.name}</span>
          </>
        )}
        {entry.fields.length ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground ml-auto h-6 shrink-0 px-2 text-xs"
            aria-expanded={fieldsOpen}
            aria-label={`${fieldsOpen ? "Hide" : "Show"} ${fieldCount} in ${entry.name}`}
            onClick={() => setFieldsOpen((value) => !value)}
          >
            {fieldCount}
          </Button>
        ) : null}
      </div>
      {entry.fields.length && fieldsOpen ? (
        <ul
          aria-label={`Fields in ${entry.name}`}
          className={`border-border grid gap-1.5 border-l pl-3 ${showActions ? "ml-10" : "ml-1"}`}
        >
          {entry.fields.map((field) => (
            <li key={changeKey(field)} className="flex items-start gap-2">
              <ChangeRow change={field} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const changeKey = (change: Change) => `${change.kind}-${change.sandboxId}`;
const flatRow = (change: Change) => (
  <div className="flex items-start gap-2">
    <ChangeRow change={change} />
  </div>
);

export function PublishChangeGroups({
  changes,
  design,
}: {
  changes: readonly Change[];
  design: PublishReviewDesign;
}) {
  const groups = groupPublicationChanges(changes, design);
  return (
    <ShowActions.Provider value={sharedAction(changes) === null}>
      <div className="grid gap-4">
        <p className="text-muted-foreground text-sm">
          {publicationChangeSummary(changes)}
        </p>
        <ChangeGroup
          title="Departments"
          noun={KIND_NOUNS.department}
          items={groups.departments}
          itemKey={changeKey}
          render={flatRow}
        />
        <ChangeGroup
          title="Modules"
          noun={KIND_NOUNS.module}
          items={groups.modules}
          itemKey={(entry) => entry.id}
          render={(entry) => <ModuleChanges entry={entry} />}
        />
        <ChangeGroup
          title="Relationships"
          noun={KIND_NOUNS.relationship}
          items={groups.relationships}
          itemKey={changeKey}
          render={flatRow}
        />
        <ChangeGroup
          title="Automations"
          noun={KIND_NOUNS.automation}
          items={groups.automations}
          itemKey={changeKey}
          render={flatRow}
        />
        <ChangeGroup
          title="Other"
          noun={["change", "changes"]}
          items={groups.other}
          itemKey={changeKey}
          render={flatRow}
        />
      </div>
    </ShowActions.Provider>
  );
}
