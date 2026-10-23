"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/components/ui/search-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toggleVariants } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

import {
  catalogDepartments,
  catalogGroups,
  type AccessCatalogSearch,
} from "../hooks/use-access-catalog";
import {
  defaultDirectoryFilters,
  inactiveDaysError,
  parseInactiveDays,
  quickStatusFilters,
  rareStatusFilters,
  roleLabels,
  type DirectoryFilters,
  type DirectoryStatusFilter,
} from "../helpers/people";
import { FilterRow, FilterSelect, filterRowClassName } from "./access-toolbar";

type Change = (patch: Partial<DirectoryFilters>) => void;

/**
 * The status strip beside the People search: the common statuses with
 * organization totals, then More for the rare ones (Expired, Deleted,
 * Everyone, including deleted). A rare status shows as the strip's selected
 * item.
 */
export function StatusStrip({
  status,
  totals,
  onChange,
}: {
  status: DirectoryStatusFilter;
  totals: Partial<Record<DirectoryStatusFilter, number>>;
  onChange: Change;
}) {
  const rare = rareStatusFilters.find((filter) => filter.status === status);
  return (
    <ToggleGroup
      aria-label="Status"
      variant="segmented"
      multiple={false}
      value={[status]}
      // On a phone the strip scrolls sideways; its right edge fades so the
      // hidden items are hinted, and end padding lets More clear the fade.
      className="w-full max-w-full flex-nowrap overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pr-8 md:w-fit [&>*]:shrink-0"
      onValueChange={(selection) => {
        const next = quickStatusFilters.find(
          (filter) => filter.status === selection[0],
        );
        if (next) onChange({ status: next.status });
      }}
    >
      {quickStatusFilters.map((filter) => {
        const total = totals[filter.status];
        return (
          <ToggleGroupItem
            key={filter.status}
            value={filter.status}
            className="flex-none gap-1.5 px-2 text-sm whitespace-nowrap"
          >
            {filter.label}
            {total === undefined ? null : (
              <span className="text-muted-foreground font-normal tabular-nums">
                {total}
              </span>
            )}
          </ToggleGroupItem>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              data-slot="toggle-group-item"
              data-current={rare ? "true" : undefined}
              // The trigger names the rare status it shows.
              aria-label={rare ? `Status: ${rare.label}` : "More statuses"}
              className={cn(
                toggleVariants({ variant: "segmented" }),
                // Wide enough for "Expired" and "Deleted"; the longer
                // "Everyone, including deleted" widens it when chosen.
                "text-muted-foreground hover:text-foreground h-auto min-h-11 min-w-[6.5rem] flex-none justify-center gap-1 px-2 text-sm whitespace-nowrap hover:bg-transparent xl:min-h-9",
                "data-[current=true]:text-action-text data-[current=true]:bg-[var(--surface-raised)] data-[current=true]:font-semibold data-[current=true]:shadow-[var(--lift),inset_0_0_0_1px_color-mix(in_oklab,var(--ink-muted)_60%,transparent)]",
              )}
            />
          }
        >
          {rare ? rare.label : "More"}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="access-ui">
          {rareStatusFilters.map((filter) => (
            <DropdownMenuItem
              key={filter.status}
              role="menuitemradio"
              aria-checked={filter.status === status}
              className="min-h-11 xl:min-h-8"
              onClick={() => onChange({ status: filter.status })}
            >
              <Check
                aria-hidden="true"
                className={cn(filter.status !== status && "invisible")}
              />
              {filter.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ToggleGroup>
  );
}

/** The inactivity period of the Activity filter, applied once it is valid. */
function InactiveDaysInput({
  days,
  errorId,
  onApply,
  onError,
}: {
  days: number;
  errorId: string;
  onApply: (days: number) => void;
  onError: (error: string | null) => void;
}) {
  const [draft, setDraft] = useState(String(days));
  const [invalid, setInvalid] = useState(false);
  return (
    <Input
      aria-label="Inactive for (days)"
      inputMode="numeric"
      value={draft}
      aria-invalid={invalid}
      aria-describedby={invalid ? errorId : undefined}
      className="min-h-11 w-16 shrink-0 tabular-nums"
      onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        const problem = inactiveDaysError(value);
        setInvalid(Boolean(problem));
        onError(problem);
        const parsed = parseInactiveDays(value);
        if (!problem && parsed !== null) onApply(parsed);
      }}
    />
  );
}

/** Activity: any, no recorded sign-in, or inactive for n days. */
function ActivityRow({
  filters,
  onChange,
}: {
  filters: DirectoryFilters;
  onChange: Change;
}) {
  const [error, setError] = useState<string | null>(null);
  const history = filters.history ?? "all";
  const options = [
    { value: "all", label: "Any" },
    { value: "no-recorded-sign-in", label: "No recorded sign-in" },
    { value: "inactive", label: "Inactive for" },
  ] as const;
  return (
    <Field className={filterRowClassName}>
      <FieldLabel
        htmlFor="people-history-filter"
        className="md:text-muted-foreground"
      >
        Activity
      </FieldLabel>
      <div className="flex min-w-0 items-center gap-2">
        <NativeSelect
          id="people-history-filter"
          className="min-w-0 flex-1 [&_select]:min-h-11"
          value={history}
          onChange={(event) => {
            const option = options.find(
              (item) => item.value === event.target.value,
            );
            if (!option) return;
            setError(null);
            onChange({ history: option.value });
          }}
        >
          {options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {history === "inactive" ? (
          <>
            <InactiveDaysInput
              days={
                filters.inactiveDays ?? defaultDirectoryFilters.inactiveDays!
              }
              errorId="people-inactive-days-error"
              onApply={(inactiveDays) => onChange({ inactiveDays })}
              onError={setError}
            />
            <span aria-hidden="true" className="text-muted-foreground text-sm">
              days
            </span>
          </>
        ) : null}
      </div>
      {error && history === "inactive" ? (
        <FieldError id="people-inactive-days-error" className="md:col-start-2">
          {error}
        </FieldError>
      ) : null}
    </Field>
  );
}

/** Fixed options first, kept only while they match the typed search. */
function withFixed(
  fixed: readonly SearchSelectOption[],
  search: string,
  rest: readonly SearchSelectOption[],
): SearchSelectOption[] {
  const needle = search.trim().toLowerCase();
  return [
    ...fixed.filter(
      (option) => !needle || option.label.toLowerCase().includes(needle),
    ),
    ...rest,
  ];
}

const anyGroup = { value: "all", label: "Any group" };
const noGroup = { value: "none", label: "In no group" };
const anyDepartment = { value: "all", label: "Any department" };

/**
 * The People Filters rows: Role, Group, Department, Two-step, and Activity.
 * Group and Department search inside their own dropdown.
 */
export function PeopleFilterRows({
  filters,
  groups,
  departments,
  onChange,
}: {
  filters: DirectoryFilters;
  groups: AccessCatalogSearch;
  departments: AccessCatalogSearch;
  onChange: Change;
}) {
  const groupOptions = catalogGroups(groups.combined).map((group) => ({
    value: group.id,
    label: group.name,
    description: `${group.member_ids.length} ${group.member_ids.length === 1 ? "member" : "members"}`,
  }));
  const departmentOptions = catalogDepartments(departments.combined).map(
    (department) => ({
      value: department.id,
      label: department.department_name,
    }),
  );
  return (
    <>
      <FilterSelect
        id="people-role-filter"
        label="Role"
        value={filters.role}
        options={[
          { value: "all", label: "Any role" },
          { value: "admin", label: roleLabels.admin },
          { value: "member", label: roleLabels.member },
          { value: "guest", label: roleLabels.guest },
        ]}
        onChange={(role) => onChange({ role })}
      />
      <FilterRow>
        <SearchSelect
          id="people-group-filter"
          popupClassName="access-ui"
          label="Group"
          value={filters.groupId}
          options={withFixed([anyGroup, noGroup], groups.search, groupOptions)}
          // "Any" shows as the placeholder, so a search lists only matches.
          selectedOption={[noGroup, ...groupOptions].find(
            (option) => option.value === filters.groupId,
          )}
          onValueChange={(groupId) => onChange({ groupId })}
          search={groups.search}
          onSearchChange={groups.onSearchChange}
          loading={groups.loading}
          error={groups.error || undefined}
          onRetry={() => void groups.retry()}
          hasMore={groups.hasMore}
          onLoadMore={() => void groups.loadMore()}
          loadingMore={groups.loadingMore}
          placeholder="Any group"
          searchPlaceholder="Search groups"
          emptyMessage="No groups match."
        />
      </FilterRow>
      <FilterRow>
        <SearchSelect
          id="people-department-filter"
          popupClassName="access-ui"
          label="Department"
          value={filters.departmentId}
          options={withFixed(
            [anyDepartment],
            departments.search,
            departmentOptions,
          )}
          selectedOption={departmentOptions.find(
            (option) => option.value === filters.departmentId,
          )}
          onValueChange={(departmentId) => onChange({ departmentId })}
          search={departments.search}
          onSearchChange={departments.onSearchChange}
          loading={departments.loading}
          error={departments.error || undefined}
          onRetry={() => void departments.retry()}
          hasMore={departments.hasMore}
          onLoadMore={() => void departments.loadMore()}
          loadingMore={departments.loadingMore}
          placeholder="Any department"
          searchPlaceholder="Search departments"
          emptyMessage="No departments match."
        />
      </FilterRow>
      <FilterSelect
        id="people-mfa-filter"
        label="Two-step"
        ariaLabel="Administrator two-step verification"
        value={filters.mfa ?? "all"}
        options={[
          { value: "all", label: "Any" },
          { value: "without", label: "Off (administrators)" },
          { value: "unknown", label: "Unknown (administrators)" },
        ]}
        onChange={(mfa) => onChange({ mfa })}
      />
      <ActivityRow filters={filters} onChange={onChange} />
    </>
  );
}
