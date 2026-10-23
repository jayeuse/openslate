"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  SandboxDocumentField,
  SandboxFieldValue,
} from "../domain/document";
import { TestValueRow } from "./test-setup-rows";

export type TestValueFilter = "relevant" | "all" | "edited";

/**
 * The test values of the Setup pane: the Relevant, All, and Edited switch,
 * a search past 12 fields, and one label-left row per shown field. The
 * workspace owns the filter, search, and limit, because Run test and an
 * issue's "Show … input" open a hidden field.
 */
export function TestValues({
  fields,
  shownFields,
  values,
  relevantCount,
  editedCount,
  filter,
  search,
  limit,
  busy,
  errorFor,
  onFilter,
  onSearch,
  onLimit,
  onValue,
}: {
  fields: readonly SandboxDocumentField[];
  /** The fields the filter or search matches, before the limit. */
  shownFields: readonly SandboxDocumentField[];
  values: Readonly<Record<string, SandboxFieldValue>>;
  relevantCount: number;
  editedCount: number;
  filter: TestValueFilter;
  search: string;
  limit: number;
  busy: boolean;
  errorFor: (fieldId: string) => string | undefined;
  onFilter: (filter: TestValueFilter) => void;
  onSearch: (search: string) => void;
  onLimit: (limit: number) => void;
  onValue: (fieldId: string, value: SandboxFieldValue) => void;
}) {
  return (
    <fieldset
      className="grid min-w-0 gap-3 xl:gap-2"
      aria-labelledby="sandbox-test-values-label"
    >
      <legend className="mb-1 flex items-center gap-1 text-sm font-semibold">
        <span id="sandbox-test-values-label">Test values</span>
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="About Relevant"
                className="text-muted-foreground hover:text-foreground focus-visible:outline-ring -my-2 inline-flex size-11 items-center justify-center rounded-sm outline-none focus-visible:outline-2 xl:my-0 xl:size-6"
              />
            }
          >
            <Info aria-hidden="true" className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent side="top" className="slim-ui w-auto max-w-64">
            Relevant: required fields and fields your triggers use. Hidden
            fields keep their values.
          </PopoverContent>
        </Popover>
      </legend>
      <ToggleGroup
        aria-label="Input fields"
        multiple={false}
        disabled={busy}
        value={[filter]}
        onValueChange={(selection) => {
          const selected = selection[0];
          if (
            selected === "relevant" ||
            selected === "all" ||
            selected === "edited"
          )
            onFilter(selected);
          onSearch("");
          onLimit(12);
        }}
        variant="segmented"
      >
        <ToggleGroupItem value="relevant">
          Relevant ({relevantCount})
        </ToggleGroupItem>
        <ToggleGroupItem value="all">All ({fields.length})</ToggleGroupItem>
        <ToggleGroupItem value="edited">Edited ({editedCount})</ToggleGroupItem>
      </ToggleGroup>
      {fields.length > 12 ? (
        <SearchField
          label="Find a field"
          placeholder="Find a field…"
          value={search}
          onValueChange={(next) => {
            onSearch(next);
            onLimit(12);
          }}
          className="w-full"
        />
      ) : null}
      {shownFields.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {search
            ? "No fields match your search."
            : filter === "edited"
              ? "No inputs have been edited."
              : "No relevant fields."}
        </p>
      )}
      {shownFields.slice(0, limit).map((field) => (
        <TestValueRow
          key={field.id}
          field={field}
          value={values[field.id] ?? null}
          error={errorFor(field.id)}
          onChange={(next) => onValue(field.id, next)}
        />
      ))}
      {shownFields.length > limit && (
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => onLimit(limit + 12)}
        >
          Show more fields
        </Button>
      )}
      {shownFields.length > limit || search ? (
        <p className="text-muted-foreground text-xs">
          Showing {Math.min(limit, shownFields.length)} of {shownFields.length}{" "}
          matching fields · {fields.length} total
        </p>
      ) : null}
    </fieldset>
  );
}
