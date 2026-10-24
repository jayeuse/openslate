"use client";

import { useId } from "react";
import { RefreshCw } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";

import type { AccessSecurityEventOutcome } from "../adapters/security-events-api";
import { eventLabels } from "../helpers/security-event-sentences";
import type { usePeopleSearch } from "../hooks/use-people-search";
import {
  AccessToolbar,
  FilterRow,
  filterRowClassName,
  type FilterChip,
} from "./access-toolbar";
import { outcomes } from "./security-event-facts";

export const securityEventSorts = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "event", label: "Event name" },
  { value: "outcome", label: "Outcome" },
] as const;
export type SecurityEventSort = (typeof securityEventSorts)[number]["value"];

export type SecurityEventFilters = {
  search: string;
  type: string;
  exactType: string;
  outcome: AccessSecurityEventOutcome | "";
  person: string;
  from: string;
  through: string;
  sort: SecurityEventSort;
};

export const initialSecurityEventFilters: SecurityEventFilters = {
  search: "",
  type: "",
  exactType: "",
  outcome: "",
  person: "",
  from: "",
  through: "",
  sort: "newest",
};

// The quick filter's "all" item stands for no outcome filter ("").
const outcomeOptions: readonly {
  value: AccessSecurityEventOutcome | "all";
  label: string;
}[] = [
  { value: "all", label: "All" },
  ...(
    Object.entries(outcomes) as [
      AccessSecurityEventOutcome,
      (typeof outcomes)[AccessSecurityEventOutcome],
    ][]
  ).map(([value, item]) => ({ value, label: item.label })),
];

const typeOptions = [
  { value: "", label: "All event types" },
  ...Object.entries(eventLabels).map(([value, label]) => ({ value, label })),
  { value: "other", label: "Other event type" },
];

type People = ReturnType<typeof usePeopleSearch>;

/**
 * The Security events toolbar, in the Activity grammar (MD6): search, the
 * outcome quick filter, the Filters popover (Event type as a searchable
 * list, Person, From, Through) and the active filters as chips, then Sort
 * and a quiet Refresh. Errors stay beside their field.
 */
export function SecurityEventsToolbar({
  filters,
  onChange,
  onClearFilters,
  region,
  pending,
  denied,
  refreshDisabled,
  onRefresh,
  people,
  personOptions,
  selectedPersonOption,
  personMode,
  onPersonModeChange,
  onDirectoryRequested,
  directoryRequested,
  errors,
}: {
  filters: SecurityEventFilters;
  onChange: (patch: Partial<SecurityEventFilters>) => void;
  onClearFilters: () => void;
  region: WorkspaceRegion | undefined;
  pending: boolean;
  denied: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  people: People;
  personOptions: readonly { value: string; label: string }[];
  selectedPersonOption: { value: string; label: string } | undefined;
  personMode: "directory" | "id";
  onPersonModeChange: (mode: "directory" | "id") => void;
  onDirectoryRequested: () => void;
  directoryRequested: boolean;
  errors: { uuid: string; type: string; day: string };
}) {
  const id = useId();
  const dayText = (day: string) =>
    region ? formatWorkspaceDate(day, region) : day;
  const chips: FilterChip[] = [];
  if (filters.type)
    chips.push({
      key: "type",
      label: "Event type",
      value:
        filters.type === "other"
          ? filters.exactType.trim() || "Other event type"
          : (eventLabels[filters.type] ?? filters.type),
      onRemove: () => onChange({ type: "", exactType: "" }),
    });
  if (filters.person)
    chips.push({
      key: "person",
      label: "Person",
      value:
        personMode === "id"
          ? filters.person
          : (selectedPersonOption?.label ?? "Unknown person"),
      onRemove: () => onChange({ person: "" }),
    });
  if (filters.from)
    chips.push({
      key: "from",
      label: "From",
      value: dayText(filters.from),
      onRemove: () => onChange({ from: "" }),
    });
  if (filters.through)
    chips.push({
      key: "through",
      label: "Through",
      value: dayText(filters.through),
      onRemove: () => onChange({ through: "" }),
    });

  return (
    <AccessToolbar
      searchLabel="Search security events"
      placeholder="Search recorded events"
      searchMaxLength={200}
      query={filters.search}
      onQueryChange={(search) => onChange({ search })}
      sortLabel="Sort security events"
      sort={filters.sort}
      sortOptions={securityEventSorts}
      onSortChange={(sort) => onChange({ sort })}
      chips={chips}
      onClearFilters={onClearFilters}
      filtersDisabled={pending}
      sortInFiltersBelowMd
      quickFilters={
        <ToggleGroup
          aria-label="Outcome"
          variant="segmented"
          multiple={false}
          value={[filters.outcome || "all"]}
          disabled={pending}
          className="w-full max-w-full flex-nowrap overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pr-8 md:w-fit [&>*]:shrink-0"
          onValueChange={(selection) => {
            const next = outcomeOptions.find(
              (option) => option.value === selection[0],
            );
            if (next)
              onChange({ outcome: next.value === "all" ? "" : next.value });
          }}
        >
          {outcomeOptions.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="min-w-11 flex-none px-2 text-sm whitespace-nowrap xl:min-w-0"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 xl:size-8"
          aria-label="Refresh security events"
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      }
    >
      <FilterRow>
        <SearchSelect
          id={`${id}-type`}
          label="Event type"
          popupClassName="slim-ui"
          value={filters.type}
          options={typeOptions}
          placeholder="All event types"
          emptyMessage="No event type matches."
          disabled={pending}
          onValueChange={(type) => onChange({ type })}
        />
      </FilterRow>
      {filters.type === "other" ? (
        <Field className={filterRowClassName}>
          <FieldLabel
            htmlFor={`${id}-exact-type`}
            className="md:text-muted-foreground"
          >
            Exact event type
          </FieldLabel>
          <div className="min-w-0">
            <Input
              id={`${id}-exact-type`}
              value={filters.exactType}
              maxLength={100}
              className="min-h-11"
              aria-invalid={Boolean(errors.type)}
              aria-describedby={errors.type ? `${id}-type-error` : undefined}
              onChange={(event) => onChange({ exactType: event.target.value })}
            />
            {errors.type ? (
              <FieldError id={`${id}-type-error`}>{errors.type}</FieldError>
            ) : null}
          </div>
        </Field>
      ) : null}
      <div className="grid min-w-0 gap-1" onFocusCapture={onDirectoryRequested}>
        {personMode === "directory" ? (
          <FilterRow>
            <SearchSelect
              label="Person"
              popupClassName="slim-ui"
              value={filters.person}
              options={personOptions}
              onValueChange={(person) => onChange({ person })}
              search={people.search}
              onSearchChange={people.onSearchChange}
              selectedOption={selectedPersonOption}
              loading={people.loading}
              error={people.error}
              onRetry={people.retry}
              hasMore={people.hasMore}
              onLoadMore={() => void people.loadMore()}
              loadingMore={people.loadingMore}
              disabled={pending || denied}
              placeholder="All people"
              emptyMessage={
                people.loading ? "Loading people…" : "No one matches."
              }
            />
          </FilterRow>
        ) : (
          <Field className={filterRowClassName}>
            <FieldLabel
              htmlFor={`${id}-person-id`}
              className="md:text-muted-foreground"
            >
              Person ID
            </FieldLabel>
            <div className="min-w-0">
              <Input
                id={`${id}-person-id`}
                value={filters.person}
                maxLength={36}
                className="min-h-11"
                aria-invalid={Boolean(errors.uuid)}
                aria-describedby={`${id}-person-help${errors.uuid ? ` ${id}-person-error` : ""}`}
                onChange={(event) => onChange({ person: event.target.value })}
              />
              <p
                id={`${id}-person-help`}
                className="text-muted-foreground mt-1 text-xs"
              >
                Use the ID shown in an event&apos;s details. This also finds
                people no longer in the directory.
              </p>
              {errors.uuid ? (
                <FieldError id={`${id}-person-error`}>{errors.uuid}</FieldError>
              ) : null}
            </div>
          </Field>
        )}
        <Button
          type="button"
          variant="ghost"
          className="text-action-text min-h-11 w-fit justify-start px-0 text-sm underline underline-offset-4 hover:bg-transparent md:ml-[6.75rem] xl:min-h-8"
          onClick={() =>
            onPersonModeChange(personMode === "directory" ? "id" : "directory")
          }
        >
          {personMode === "directory"
            ? "Enter a person ID"
            : "Choose from directory"}
        </Button>
        {people.error && directoryRequested ? (
          <Alert
            role="alert"
            variant="destructive"
            className="space-y-2 text-sm"
          >
            <p>
              The person list could not load. Enter a person ID, or try again.
            </p>
            <Button
              variant="ghost"
              className="min-h-11 px-0"
              onClick={people.retry}
            >
              Retry person list
            </Button>
          </Alert>
        ) : null}
      </div>
      <Field className={filterRowClassName}>
        <FieldLabel htmlFor={`${id}-from`} className="md:text-muted-foreground">
          From
        </FieldLabel>
        <Input
          id={`${id}-from`}
          type="date"
          value={filters.from}
          className="min-h-11"
          disabled={pending}
          aria-invalid={Boolean(errors.day) || undefined}
          aria-describedby={errors.day ? `${id}-day-error` : undefined}
          onChange={(event) => onChange({ from: event.target.value })}
        />
      </Field>
      <Field className={filterRowClassName}>
        <FieldLabel
          htmlFor={`${id}-through`}
          className="md:text-muted-foreground"
        >
          Through
        </FieldLabel>
        <Input
          id={`${id}-through`}
          type="date"
          value={filters.through}
          className="min-h-11"
          disabled={pending}
          aria-invalid={Boolean(errors.day) || undefined}
          aria-describedby={errors.day ? `${id}-day-error` : undefined}
          onChange={(event) => onChange({ through: event.target.value })}
        />
      </Field>
      {errors.day ? (
        <p
          id={`${id}-day-error`}
          role="alert"
          className="text-destructive text-sm md:ml-[6.75rem]"
        >
          {errors.day}
        </p>
      ) : null}
    </AccessToolbar>
  );
}
