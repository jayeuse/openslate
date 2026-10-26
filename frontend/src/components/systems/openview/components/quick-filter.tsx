"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toggleVariants } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { queryOpenViewAggregates } from "../adapters/analytics-api";
import { openViewKeys } from "../adapters/openview-queries";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
} from "../adapters/views-api";

/** Choices shown in the strip; the rest are under More. */
const SHOWN = 3;
/** Choices counted; a choice field rarely has more. */
const COUNTED = 12;
/** The strip's All item; choice ids are UUIDs, so it cannot clash. */
const ALL = "all";

type QuickFilterChoice = { id: string; label: string; count: number };

/** The counted choices of the quick filter, and the count of All. */
export type QuickFilterCounts = {
  choices: QuickFilterChoice[];
  total: number | null;
};

/**
 * Counts the records' first choice field for the module page's quick filter
 * (OD14), with the count read Charts use. The counts leave out the strip's
 * own choice, so they stay put while one is chosen. No counts, or a field
 * with no recorded choice, gives no choices, and then there is no strip.
 */
export function useQuickFilterCounts({
  moduleId,
  fieldId,
  definition,
  refreshKey,
  enabled,
}: {
  moduleId: string;
  fieldId: string;
  /** The view's query without the strip's choice. */
  definition: OpenViewQueryDefinition;
  /** Changes when records change, so the counts read again. */
  refreshKey: number;
  enabled: boolean;
}): QuickFilterCounts {
  const counts = useQuery({
    queryKey: [
      ...openViewKeys.all,
      "quick-filter",
      moduleId,
      fieldId,
      definition,
      refreshKey,
    ],
    queryFn: () =>
      queryOpenViewAggregates({
        mode: "groups",
        moduleId,
        definition,
        aggregation: "count",
        dimension: { fieldId, expectedType: "select" },
        limit: COUNTED,
        offset: 0,
      }),
    enabled,
    // The strip keeps its last counts while the next ones read.
    placeholderData: keepPreviousData,
  });
  const items = enabled ? (counts.data?.items ?? []) : [];
  return {
    choices: items.flatMap((item) =>
      item.key === null
        ? []
        : [{ id: item.key, label: item.label, count: item.recordCount }],
    ),
    total: counts.data?.pagination.hasMore
      ? null
      : items.reduce((sum, item) => sum + item.recordCount, 0),
  };
}

/**
 * The quick filter strip: "All 30 · Active 12 · Prospect 9 · More".
 */
export function QuickFilter({
  field,
  counts: { choices, total },
  value,
  disabled,
  onChange,
}: {
  field: Pick<OpenViewDataSourceField, "name">;
  counts: QuickFilterCounts;
  /** The chosen choice's id, or null for All. */
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const shown = choices.slice(0, SHOWN);
  const more = choices.slice(SHOWN);
  const chosenMore = more.find((choice) => choice.id === value);
  return (
    <ToggleGroup
      aria-label={field.name}
      variant="segmented"
      multiple={false}
      disabled={disabled}
      value={[value ?? ALL]}
      // On a phone the strip scrolls sideways; its right edge fades.
      className="w-full max-w-full flex-nowrap overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pr-8 md:w-fit [&>*]:shrink-0"
      onValueChange={(selection) => {
        const next = selection[0];
        if (next === undefined) return;
        onChange(next === ALL ? null : next);
      }}
    >
      <ToggleGroupItem
        value={ALL}
        className="flex-none gap-1.5 px-2 text-sm whitespace-nowrap"
      >
        All
        {total === null ? null : (
          <span className="text-muted-foreground font-normal tabular-nums">
            {total}
          </span>
        )}
      </ToggleGroupItem>
      {shown.map((choice) => (
        <ToggleGroupItem
          key={choice.id}
          value={choice.id}
          className="flex-none gap-1.5 px-2 text-sm whitespace-nowrap"
        >
          {choice.label}
          <span className="text-muted-foreground font-normal tabular-nums">
            {choice.count}
          </span>
        </ToggleGroupItem>
      ))}
      {more.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            render={
              <button
                type="button"
                data-slot="toggle-group-item"
                data-current={chosenMore ? "true" : undefined}
                aria-label={
                  chosenMore
                    ? `${field.name}: ${chosenMore.label}`
                    : `More ${field.name} choices`
                }
                className={cn(
                  toggleVariants({ variant: "segmented" }),
                  "text-muted-foreground hover:text-foreground h-auto min-h-11 flex-none justify-center gap-1 px-2 text-sm whitespace-nowrap hover:bg-transparent xl:min-h-9",
                  "data-[current=true]:text-action-text data-[current=true]:bg-[var(--surface-raised)] data-[current=true]:font-semibold data-[current=true]:shadow-[var(--lift),inset_0_0_0_1px_color-mix(in_oklab,var(--ink-muted)_60%,transparent)]",
                )}
              />
            }
          >
            {chosenMore ? chosenMore.label : "More"}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="slim-ui">
            {more.map((choice) => (
              <DropdownMenuItem
                key={choice.id}
                role="menuitemradio"
                aria-checked={choice.id === value}
                className="min-h-11 xl:min-h-8"
                onClick={() => onChange(choice.id)}
              >
                <Check
                  aria-hidden="true"
                  className={choice.id === value ? undefined : "invisible"}
                />
                {choice.label}
                <span className="text-muted-foreground ml-auto pl-4 tabular-nums">
                  {choice.count}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </ToggleGroup>
  );
}
