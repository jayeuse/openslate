"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { cn } from "@/lib/utils";

import { accessCatalogOptions } from "../hooks/use-access-catalog";
import {
  endsInLabel,
  formatDateTime,
  lastActiveLabel,
  lastSeenAt,
  roleLabels,
  type DirectoryRow,
  type NamedItem,
} from "../helpers/people";
import type { PersonMemberships } from "../hooks/use-people-memberships";
import type { AccessDirectoryUser } from "../state/api";

// The cells of the People row grammar (DESIGN.md, Access rows): a word for
// the role, a dot and a word for status, chips for groups, marks for
// departments, a shield for two-step, and relative last activity.

export type PeopleRow = DirectoryRow<AccessDirectoryUser> & {
  membership?: PersonMemberships;
};

const dotTone = {
  active: "bg-[var(--flow)]",
  pending: "shadow-[inset_0_0_0_1.5px_var(--ink-muted)]",
  disabled: "bg-[var(--rule-strong)]",
  expired: "bg-[var(--rule-strong)]",
  deleted: "bg-[var(--rule-strong)]",
} as const;

/** Status as a dot and a word; a guest whose access ends soon shows the days left. */
export function StatusWord({ row, now }: { row: PeopleRow; now: number }) {
  const ending = row.state.expiresSoon && row.user.expires_at;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          ending ? "bg-[var(--warn)]" : dotTone[row.state.id],
        )}
      />
      <span className="truncate">
        {ending ? endsInLabel(ending, now) : row.state.label}
      </span>
    </span>
  );
}

/** A role is a word; the administrator role is the one tinted chip. */
export function RoleWord({ role }: { role: AccessDirectoryUser["role"] }) {
  return role === "admin" ? (
    <Badge
      variant="default"
      className="h-[22px] bg-[var(--action-tint)] text-[var(--action-text)]"
    >
      {roleLabels.admin}
    </Badge>
  ) : (
    <span>{roleLabels[role]}</span>
  );
}

/** Two-step verification as recorded: On (with a shield), Off, or Unknown. */
export function TwoStepWord({ person }: { person: AccessDirectoryUser }) {
  if (person.mfa_verified_totp === null)
    return <span className="text-muted-foreground">Unknown</span>;
  return person.mfa_verified_totp ? (
    <span className="inline-flex items-center gap-1.5">
      <ShieldCheck
        aria-hidden="true"
        className="size-3.5 shrink-0 text-[var(--flow-text)]"
      />
      On
    </span>
  ) : (
    <span className="text-muted-foreground">Off</span>
  );
}

/** Relative last activity; the full time is in the title and `dateTime`. */
export function LastActive({
  person,
  now,
}: {
  person: AccessDirectoryUser;
  now: number;
}) {
  const region = useWorkspaceDisplayRegion();
  const value = lastSeenAt(person);
  const label = lastActiveLabel(value, now);
  if (value === null)
    return <span className="text-muted-foreground">{label}</span>;
  return (
    <time
      dateTime={value}
      title={formatDateTime(value, region)}
      className="text-muted-foreground tabular-nums"
    >
      {label}
    </time>
  );
}

// Row chips go through Badge, so each look's chip skin (Triplicate stamps,
// Stockroom tape) applies in the row as it does in the sheet.
const chipClassName =
  "block h-[22px] max-w-40 min-w-0 shrink truncate py-0 leading-[22px]";

/**
 * A person's groups as chips: the first one, then "+n" for the rest of the
 * total the server reports, so a partial page never reads as complete.
 * Loading more groups happens in the person sheet.
 */
export function GroupChips({ row }: { row: PeopleRow }) {
  const membership = row.membership;
  if (row.user.role === "admin")
    return <span className="text-muted-foreground">Not needed</span>;
  if (!membership || membership.loading)
    return (
      <span role="status" className="text-muted-foreground">
        Loading groups…
      </span>
    );
  const listed =
    !membership.denied && !(membership.error && !membership.loaded);
  const groups = listed ? membership.groups : [];
  const total = Math.max(membership.total, groups.length);
  const more = total - Math.min(1, groups.length);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {groups.length ? (
        <Badge
          variant="secondary"
          className={chipClassName}
          title={groups[0]!.name}
        >
          {groups[0]!.name}
        </Badge>
      ) : listed && total === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : null}
      {groups.length && more > 0 ? (
        <span
          className="text-muted-foreground shrink-0 px-0.5 text-xs tabular-nums"
          title={groups
            .slice(1)
            .map((group) => group.name)
            .join(", ")}
        >
          +{more}
          <span className="sr-only">
            {" "}
            more {more === 1 ? "group" : "groups"}
          </span>
        </span>
      ) : null}
      {membership.error ? (
        <span role="alert" className="text-muted-foreground truncate">
          {membership.error}
        </span>
      ) : null}
      {membership.retryFirstPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="relative z-10 min-h-11 shrink-0 px-2 xl:min-h-7"
          disabled={membership.recovering}
          onClick={() => void membership.retry()}
        >
          Retry groups
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Each department's position for its mark color: the first catalog page by
 * name, the order OpenComms uses, so a department has the same color in
 * Access and OpenComms. It is the read the People department filter and the
 * group access editor already make, so the marks add no request there; a
 * department past that page has no mark. Only administrators read the whole
 * catalog, so other viewers pass `enabled: false` and see names alone.
 */
export function useDepartmentOrder(
  enabled = true,
): (id: string) => number | null {
  const order = useQuery({
    ...accessCatalogOptions("departments", {
      limit: 25,
      offset: 0,
      search: "",
      deleted: "exclude",
    }),
    enabled,
  });
  return (id) => {
    const index = order.data?.items.findIndex((item) => item.id === id) ?? -1;
    return index < 0 ? null : index;
  };
}

/** Departments a person reaches, in catalog order, unknown ones last. */
export function orderedDepartments(
  departments: readonly NamedItem[],
  position: (id: string) => number | null,
): (NamedItem & { index: number | null })[] {
  return departments
    .map((department) => ({ ...department, index: position(department.id) }))
    .sort(
      (left, right) =>
        (left.index ?? Infinity) - (right.index ?? Infinity) ||
        left.name.localeCompare(right.name),
    );
}

const MARKS_SHOWN = 4;

/**
 * Departments as their Sandbox marks and a count. The names are the marks'
 * text: in the title for the pointer and in the accessible text.
 */
export function DepartmentMarks({
  row,
  position,
}: {
  row: PeopleRow;
  position: (id: string) => number | null;
}) {
  if (row.allDepartments) return <span>All departments</span>;
  const membership = row.membership;
  if (!membership || membership.loading)
    return (
      <span role="status" className="text-muted-foreground">
        Loading departments…
      </span>
    );
  if (membership.denied || (membership.error && !membership.loaded))
    return null;
  const partial = membership.hasMore || membership.loaded < membership.total;
  const departments = orderedDepartments(membership.departments, position);
  if (!departments.length && !partial)
    return <span className="text-muted-foreground">None</span>;
  const names = departments.map((department) => department.name).join(", ");
  return (
    <span className="inline-flex min-w-0 items-center gap-[3px]" title={names}>
      {departments
        .slice(0, MARKS_SHOWN)
        .map((department) =>
          department.index === null ? null : (
            <DepartmentMark
              key={department.id}
              departmentIndex={department.index}
            />
          ),
        )}
      <span className="text-muted-foreground ml-1.5 tabular-nums">
        <span aria-hidden="true">
          {departments.length}
          {partial ? "+" : ""}
        </span>
        <span className="sr-only">
          {names || "No departments loaded"}
          {partial ? ". Departments not fully loaded" : ""}
        </span>
      </span>
    </span>
  );
}
