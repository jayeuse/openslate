"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

import {
  accessDraftFromEntries,
  accessLevels,
  accessSummary,
  entriesFromAccessDraft,
  isAccessLevel,
  setDepartmentLevel,
  setModuleLevel,
  summaryLabel,
} from "../helpers/groups";
import { levelLabels } from "../helpers/people";
import type {
  AccessDepartment,
  AccessGroupAccessEntry,
  AccessLevel,
  AccessModule,
} from "../state/api";

type DepartmentRow = {
  id: string;
  name: string;
  modules: { id: string; name: string }[];
};

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/**
 * Every department of the catalog, plus departments and modules that only
 * the group's access names (deleted or not visible), so a full replacement
 * keeps them.
 */
function departmentRows(
  entries: readonly AccessGroupAccessEntry[],
  departments: readonly AccessDepartment[],
  modules: readonly AccessModule[],
): DepartmentRow[] {
  const rows = new Map<string, DepartmentRow>(
    departments.map((department) => [
      department.id,
      { id: department.id, name: department.department_name, modules: [] },
    ]),
  );
  for (const item of modules)
    rows
      .get(item.department_id)
      ?.modules.push({ id: item.id, name: item.module_name });
  for (const entry of entries) {
    let row = rows.get(entry.department_id);
    if (!row) {
      row = {
        id: entry.department_id,
        name: "Unavailable department",
        modules: [],
      };
      rows.set(entry.department_id, row);
    }
    if (
      entry.module_id !== null &&
      !row.modules.some((module) => module.id === entry.module_id)
    )
      row.modules.push({ id: entry.module_id, name: "Unavailable module" });
  }
  return [...rows.values()]
    .map((row) => ({ ...row, modules: [...row.modules].sort(byName) }))
    .sort(byName);
}

/** What the group gives, in one short line per department. */
export function AccessSummary({
  entries,
  departments,
  modules,
  empty,
}: {
  entries: readonly AccessGroupAccessEntry[];
  departments: readonly AccessDepartment[];
  modules: readonly AccessModule[];
  empty: string;
}) {
  const summary = accessSummary(entries, departments, modules);
  if (!summary.length)
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {summary.map((item) => (
        <li key={item.departmentId} className="break-words">
          <span className="font-medium">{summaryLabel(item)}</span>
          {item.modules.length ? (
            <span className="text-muted-foreground">
              {" "}
              (
              {item.modules
                .map((module) => `${module.name} · ${module.levelLabel}`)
                .join(", ")}
              )
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LevelSelect({
  id,
  label,
  value,
  emptyLabel,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: AccessLevel | null;
  emptyLabel: string;
  disabled: boolean;
  onChange: (level: AccessLevel | null) => void;
}) {
  return (
    <NativeSelect
      id={id}
      aria-label={label}
      value={value ?? ""}
      disabled={disabled}
      className="w-full shrink-0 sm:w-48 [&_select]:min-h-11"
      onChange={(event) => {
        const next = event.target.value;
        onChange(isAccessLevel(next) ? next : null);
      }}
    >
      <NativeSelectOption value="">{emptyLabel}</NativeSelectOption>
      {accessLevels.map((level) => (
        <NativeSelectOption key={level} value={level}>
          {levelLabels[level]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/**
 * One row per department with a level, each expandable to its modules. A
 * module is the same as its department unless it has its own level.
 */
export function GroupAccessEditor({
  entries,
  departments,
  modules,
  disabled,
  onChange,
}: {
  entries: readonly AccessGroupAccessEntry[];
  departments: readonly AccessDepartment[];
  modules: readonly AccessModule[];
  disabled: boolean;
  onChange: (entries: AccessGroupAccessEntry[]) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const draft = accessDraftFromEntries(entries);
  const rows = departmentRows(entries, departments, modules);

  function toggle(departmentId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  }

  if (!rows.length)
    return (
      <p className="text-muted-foreground rounded-lg border p-4 text-sm">
        There are no departments yet. Create departments in the Sandbox, then
        give this group access to them.
      </p>
    );

  return (
    <ul aria-label="Departments" className="flex flex-col gap-2">
      {rows.map((row) => {
        const department = draft[row.id] ?? { level: null, modules: {} };
        const overrides = Object.keys(department.modules).length;
        const open = expanded.has(row.id);
        const inherited = department.level
          ? `Same as department (${levelLabels[department.level]})`
          : "Same as department (None)";
        return (
          <li key={row.id} className="bg-card min-w-0 rounded-lg border">
            <div className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1">
                <p
                  id={`${id}-${row.id}-name`}
                  className="text-sm font-medium break-words"
                >
                  {row.name}
                </p>
                <p className="text-muted-foreground text-xs">
                  {row.modules.length === 0
                    ? "No modules"
                    : overrides
                      ? overrides === 1
                        ? `1 of ${row.modules.length} ${row.modules.length === 1 ? "module has" : "modules has"} its own level`
                        : `${overrides} of ${row.modules.length} modules have their own level`
                      : `${row.modules.length} ${row.modules.length === 1 ? "module" : "modules"}, same as department`}
                </p>
              </div>
              <LevelSelect
                id={`${id}-${row.id}-level`}
                label={`${row.name} level`}
                value={department.level}
                emptyLabel="None"
                disabled={disabled}
                onChange={(level) =>
                  onChange(
                    entriesFromAccessDraft(
                      setDepartmentLevel(draft, row.id, level),
                    ),
                  )
                }
              />
              {row.modules.length ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 justify-between sm:w-32"
                  aria-expanded={open}
                  aria-controls={`${id}-${row.id}-modules`}
                  aria-label={`Modules in ${row.name}`}
                  onClick={() => toggle(row.id)}
                >
                  Modules
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "transition-transform duration-(--motion-fast) motion-reduce:transition-none",
                      open && "rotate-180",
                    )}
                  />
                </Button>
              ) : null}
            </div>
            {row.modules.length && open ? (
              <ul
                id={`${id}-${row.id}-modules`}
                aria-label={`Modules in ${row.name}`}
                className="bg-muted/40 flex flex-col gap-2 border-t p-3 sm:pl-6"
              >
                {row.modules.map((module) => (
                  <li
                    key={module.id}
                    className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
                  >
                    <p className="min-w-0 flex-1 text-sm break-words">
                      {module.name}
                    </p>
                    <LevelSelect
                      id={`${id}-${module.id}-level`}
                      label={`${module.name} level`}
                      value={department.modules[module.id] ?? null}
                      emptyLabel={inherited}
                      disabled={disabled}
                      onChange={(level) =>
                        onChange(
                          entriesFromAccessDraft(
                            setModuleLevel(draft, row.id, module.id, level),
                          ),
                        )
                      }
                    />
                    {/* Keeps module selects aligned with the department select. */}
                    <span
                      aria-hidden="true"
                      className="hidden sm:block sm:w-32"
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
