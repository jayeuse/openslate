"use client";

import { useId } from "react";

import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { SearchSelect } from "@/components/ui/search-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";

import {
  AccessToolbar,
  FilterRow,
  filterRowClassName,
  type FilterChip,
} from "../../access/components/access-toolbar";
import { Input } from "@/components/ui/input";
import { auditKindLabel } from "../domain/audit-rules";
import type {
  ActivityFilters,
  ActivityKind,
  ActivityOrder,
} from "./audit-data";

const sortOptions: readonly { value: ActivityOrder; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const kindOptions: readonly { value: ActivityKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "update", label: "Changes" },
  { value: "create", label: "Created" },
  { value: "delete", label: "Deleted" },
];

export type AuditPersonOption = { id: string; label: string };

type ChangeFilter = <Key extends keyof ActivityFilters>(
  key: Key,
  value: ActivityFilters[Key],
) => void;

/**
 * The Activity toolbar (MD6): search, the kind quick filter, the Filters
 * popover (Person, Area, From, To) and the active filters as chips, then
 * Sort. A department manager who manages more than one department picks the
 * department here (MD12). The quick filter shows no counts: the audit API
 * returns one total per request, so counts would cost three more reads on
 * every filter change.
 */
export function AuditToolbar({
  filters,
  onChange,
  onClearFilters,
  disabled,
  region,
  dateRangeError,
  people,
  areas,
  departments,
}: {
  filters: ActivityFilters;
  onChange: ChangeFilter;
  onClearFilters: () => void;
  disabled: boolean;
  region: WorkspaceRegion | undefined;
  dateRangeError: string;
  people: {
    options: readonly AuditPersonOption[];
    selectedLabel: string;
    search: string;
    onSearchChange: (search: string) => void;
    loading: boolean;
    error?: string;
    onRetry: () => void;
    onChoose: (person: AuditPersonOption | null) => void;
  };
  areas: {
    entityTypes: readonly string[];
    loading: boolean;
    error?: string;
    onRetry: () => void;
  };
  /** Shown only when the viewer manages more than one department. */
  departments: {
    options: readonly { id: string; label: string }[];
    value: string;
    onChange: (departmentId: string) => void;
  } | null;
}) {
  const id = useId();
  const dayText = (day: string) =>
    region ? formatWorkspaceDate(day, region) : day;
  const chips: FilterChip[] = [];
  if (filters.user)
    chips.push({
      key: "person",
      label: "Person",
      value: people.selectedLabel,
      onRemove: () => {
        people.onChoose(null);
        onChange("user", "");
      },
    });
  if (filters.entity)
    chips.push({
      key: "area",
      label: "Area",
      value: auditKindLabel(filters.entity),
      onRemove: () => onChange("entity", ""),
    });
  if (filters.from)
    chips.push({
      key: "from",
      label: "From",
      value: dayText(filters.from),
      onRemove: () => onChange("from", ""),
    });
  if (filters.to)
    chips.push({
      key: "to",
      label: "To",
      value: dayText(filters.to),
      onRemove: () => onChange("to", ""),
    });

  const quickFilters = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {departments ? (
        <Field className="flex-row items-center gap-2">
          <FieldLabel
            htmlFor={`${id}-department`}
            className="text-muted-foreground font-normal whitespace-nowrap"
          >
            Department:
          </FieldLabel>
          <NativeSelect
            id={`${id}-department`}
            aria-label="Department"
            className="[&_select]:field-sizing-content [&_select]:min-h-11 [&_select]:font-medium xl:[&_select]:min-h-8"
            value={departments.value}
            disabled={disabled}
            onChange={(event) => departments.onChange(event.target.value)}
          >
            {departments.options.map((option) => (
              <NativeSelectOption key={option.id} value={option.id}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <ToggleGroup
        aria-label="Kind of event"
        variant="segmented"
        multiple={false}
        value={[filters.kind]}
        disabled={disabled}
        className="w-full max-w-full flex-nowrap overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pr-8 md:w-fit [&>*]:shrink-0"
        onValueChange={(selection) => {
          const next = kindOptions.find(
            (option) => option.value === selection[0],
          );
          if (next) onChange("kind", next.value);
        }}
      >
        {kindOptions.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="min-w-11 flex-none px-2 text-sm whitespace-nowrap xl:min-w-0"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );

  return (
    <AccessToolbar
      searchLabel="Search activity"
      placeholder="Search people, records, or changes"
      searchMaxLength={100}
      query={filters.query}
      onQueryChange={(query) => onChange("query", query)}
      sortLabel="Sort activity"
      sort={filters.order}
      sortOptions={sortOptions}
      onSortChange={(order) => onChange("order", order)}
      chips={chips}
      onClearFilters={onClearFilters}
      filtersDisabled={disabled}
      sortInFiltersBelowXl
      quickFilters={quickFilters}
    >
      <FilterRow>
        <SearchSelect
          id={`${id}-person`}
          popupClassName="slim-ui"
          label="Person"
          value={filters.user}
          placeholder="Anyone"
          options={[
            { value: "", label: "Anyone" },
            ...people.options.map((person) => ({
              value: person.id,
              label: person.label,
            })),
          ]}
          selectedOption={
            filters.user
              ? { value: filters.user, label: people.selectedLabel }
              : undefined
          }
          search={people.search}
          onSearchChange={people.onSearchChange}
          loading={people.loading}
          error={people.error}
          onRetry={people.onRetry}
          disabled={disabled}
          emptyMessage="No one matches."
          onValueChange={(value) => {
            people.onChoose(
              people.options.find((person) => person.id === value) ?? null,
            );
            onChange("user", value);
          }}
        />
      </FilterRow>
      <FilterRow>
        <SearchSelect
          id={`${id}-area`}
          popupClassName="slim-ui"
          label="Area"
          value={filters.entity}
          placeholder="Any area"
          options={[
            { value: "", label: "Any area" },
            ...areas.entityTypes.map((entityType) => ({
              value: entityType,
              label: auditKindLabel(entityType),
            })),
          ]}
          selectedOption={
            filters.entity
              ? { value: filters.entity, label: auditKindLabel(filters.entity) }
              : undefined
          }
          loading={areas.loading}
          error={areas.error}
          onRetry={areas.onRetry}
          disabled={disabled}
          emptyMessage="No area matches."
          onValueChange={(value) => onChange("entity", value)}
        />
      </FilterRow>
      <Field className={filterRowClassName}>
        <FieldLabel htmlFor={`${id}-from`} className="md:text-muted-foreground">
          From
        </FieldLabel>
        <Input
          id={`${id}-from`}
          type="date"
          value={filters.from}
          className="min-h-11"
          disabled={disabled || !region}
          aria-invalid={Boolean(dateRangeError) || undefined}
          aria-describedby={dateRangeError ? `${id}-range-error` : undefined}
          onChange={(event) => onChange("from", event.target.value)}
        />
      </Field>
      <Field className={filterRowClassName}>
        <FieldLabel htmlFor={`${id}-to`} className="md:text-muted-foreground">
          To
        </FieldLabel>
        <Input
          id={`${id}-to`}
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          className="min-h-11"
          disabled={disabled || !region}
          aria-invalid={Boolean(dateRangeError) || undefined}
          aria-describedby={dateRangeError ? `${id}-range-error` : undefined}
          onChange={(event) => onChange("to", event.target.value)}
        />
      </Field>
      {dateRangeError ? (
        <p
          id={`${id}-range-error`}
          role="alert"
          className="text-destructive text-sm md:col-start-2"
        >
          {dateRangeError}
        </p>
      ) : null}
    </AccessToolbar>
  );
}
