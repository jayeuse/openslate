"use client";

import { useId, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

import { DepartmentMark } from "@/components/sandbox/department-mark";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import {
  useAccessCatalog,
  catalogModules,
  type AccessCatalogSearch,
} from "../hooks/use-access-catalog";
import { cn } from "@/lib/utils";

import {
  accessDraftFromEntries,
  accessLevels,
  accessSummary,
  entriesFromAccessDraft,
  isAccessLevel,
  moduleCount,
  setDepartmentLevel,
  setModuleLevel,
  type DepartmentSummary,
} from "../helpers/groups";
import { levelLabels } from "../helpers/people";
import { AccessLevelBadge } from "./access-level-badge";
import { useDepartmentOrder } from "./people-row-parts";
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

/**
 * One department a group reaches: its mark, its name, the level chip, and
 * the modules with their own level. The text reads as the summary line
 * ("Inventory · Write + 1 module"), so a screen reader hears one phrase.
 */
export function DepartmentReach({
  summary,
  position,
}: {
  summary: DepartmentSummary;
  position: (id: string) => number | null;
}) {
  const index = position(summary.departmentId);
  const count = summary.modules.length;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      {index === null ? null : <DepartmentMark departmentIndex={index} />}
      <span className="min-w-0 truncate">{summary.name}</span>
      {summary.level ? (
        <>
          <span className="sr-only"> · </span>
          <AccessLevelBadge level={summary.level} />
        </>
      ) : null}
      {count ? (
        <span className="text-muted-foreground shrink-0">
          {summary.level ? " + " : " · "}
          {moduleCount(count)}
        </span>
      ) : null}
    </span>
  );
}

/** What the group gives, one line per department with its modules. */
export function AccessSummary({
  entries,
  departments,
  modules,
  empty,
  marks = true,
}: {
  entries: readonly AccessGroupAccessEntry[];
  departments: readonly AccessDepartment[];
  modules: readonly AccessModule[];
  empty: string;
  /** Administrators see department marks; other viewers see names. */
  marks?: boolean;
}) {
  const position = useDepartmentOrder(marks);
  const summary = accessSummary(entries, departments, modules);
  if (!summary.length)
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {summary.map((item) => (
        <li
          key={item.departmentId}
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        >
          <span className="font-medium">
            <DepartmentReach summary={item} position={position} />
          </span>
          {item.modules.length ? (
            <span className="text-muted-foreground inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="sr-only"> (</span>
              {item.modules.map((module, moduleIndex) => (
                <span
                  key={module.id}
                  className="inline-flex min-w-0 items-center gap-1.5"
                >
                  <span className="break-words">{module.name}</span>
                  <span className="sr-only"> · </span>
                  <AccessLevelBadge level={module.level} />
                  {moduleIndex < item.modules.length - 1 ? (
                    <span className="sr-only">, </span>
                  ) : null}
                </span>
              ))}
              <span className="sr-only">)</span>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A search box with its icon and a visible placeholder, like the toolbars. */
function SearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        className="min-h-11 pl-9"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
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
      className="w-full shrink-0 sm:w-60 [&_select]:min-h-11"
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
  departmentSearch,
  disabled,
  onChange,
}: {
  entries: readonly AccessGroupAccessEntry[];
  departments: readonly AccessDepartment[];
  modules: readonly AccessModule[];
  departmentSearch: AccessCatalogSearch;
  disabled: boolean;
  onChange: (entries: AccessGroupAccessEntry[]) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const position = useDepartmentOrder();
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

  return (
    <div className="space-y-3">
      <SearchField
        label="Search departments"
        placeholder="Search departments"
        value={departmentSearch.search}
        onChange={departmentSearch.onSearchChange}
      />
      {departmentSearch.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading departments…
        </p>
      ) : null}
      {departmentSearch.error ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{departmentSearch.error}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void departmentSearch.retry()}
          >
            Retry departments
          </Button>
        </div>
      ) : null}
      {!rows.length && !departmentSearch.loading && !departmentSearch.error ? (
        <p className="text-muted-foreground text-sm">
          {departmentSearch.search
            ? "No departments match. Try another search."
            : "There are no departments yet. Create departments in the Sandbox, then give this group access to them."}
        </p>
      ) : null}
      <ul aria-label="Departments" className="flex flex-col gap-2">
        {(departmentSearch.denied ? [] : rows).map((row) => {
          const department = draft[row.id] ?? { level: null, modules: {} };
          const overrides = Object.keys(department.modules).length;
          const open = expanded.has(row.id);
          const mark = position(row.id);
          const inherited = department.level
            ? `Same as department (${levelLabels[department.level]})`
            : "Same as department (None)";
          return (
            <li key={row.id} className="bg-card min-w-0 rounded-lg border">
              <div className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
                <div className="min-w-0 flex-1">
                  <p
                    id={`${id}-${row.id}-name`}
                    className="flex min-w-0 items-center gap-1.5 text-sm font-medium"
                  >
                    {mark === null ? null : (
                      <DepartmentMark departmentIndex={mark} />
                    )}
                    <span className="min-w-0 break-words">{row.name}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {overrides === 0
                      ? "No module overrides"
                      : overrides === 1
                        ? "1 module has its own level"
                        : `${overrides} modules have their own level`}
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
              </div>
              {open ? (
                <DepartmentModules
                  regionId={`${id}-${row.id}-modules`}
                  departmentId={row.id}
                  departmentName={row.name}
                  entries={entries}
                  disabled={disabled || Boolean(departmentSearch.error)}
                  inherited={inherited}
                  onChange={onChange}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {departmentSearch.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={departmentSearch.loadingMore}
          onClick={() => void departmentSearch.loadMore()}
        >
          Load more departments
        </Button>
      ) : null}
    </div>
  );
}

function DepartmentModules({
  regionId,
  departmentId,
  departmentName,
  entries,
  disabled,
  inherited,
  onChange,
}: {
  regionId: string;
  departmentId: string;
  departmentName: string;
  entries: readonly AccessGroupAccessEntry[];
  disabled: boolean;
  inherited: string;
  onChange: (entries: AccessGroupAccessEntry[]) => void;
}) {
  const id = useId();
  const search = useAccessCatalog({
    kind: "modules",
    departmentId,
    selectedIds: entries.flatMap((entry) =>
      entry.department_id === departmentId && entry.module_id
        ? [entry.module_id]
        : [],
    ),
  });
  const modules = catalogModules(search.combined).filter(
    (module) => module.department_id === departmentId,
  );
  const draft = accessDraftFromEntries(entries);
  const department = draft[departmentId] ?? { level: null, modules: {} };
  return (
    <div className="bg-muted/40 space-y-3 border-t p-3 sm:pl-6">
      <SearchField
        label={`Search modules in ${departmentName}`}
        placeholder="Search modules"
        value={search.search}
        onChange={search.onSearchChange}
      />
      {search.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading modules…
        </p>
      ) : null}
      {search.error ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{search.error}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void search.retry()}
          >
            Retry modules
          </Button>
        </div>
      ) : null}
      {!modules.length && !search.loading && !search.error ? (
        <p className="text-muted-foreground text-sm">
          {search.search ? "No modules match." : "No modules."}
        </p>
      ) : null}
      <ul
        id={regionId}
        aria-label={`Modules in ${departmentName}`}
        className="flex flex-col gap-2"
      >
        {modules.map((module) => (
          <li
            key={module.id}
            className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
          >
            <p className="min-w-0 flex-1 text-sm break-words">
              {module.module_name}
            </p>
            <LevelSelect
              id={`${id}-${module.id}-level`}
              label={`${module.module_name} level`}
              value={department.modules[module.id] ?? null}
              emptyLabel={inherited}
              disabled={disabled || Boolean(search.error)}
              onChange={(level) =>
                onChange(
                  entriesFromAccessDraft(
                    setModuleLevel(draft, departmentId, module.id, level),
                  ),
                )
              }
            />
            <span aria-hidden="true" className="hidden sm:block sm:w-32" />
          </li>
        ))}
      </ul>
      {search.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={search.loadingMore}
          onClick={() => void search.loadMore()}
        >
          Load more modules
        </Button>
      ) : null}
    </div>
  );
}
