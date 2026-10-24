"use client";

import { useId } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  AccessToolbar,
  FilterSelect,
  type FilterChip,
} from "../../access/components/access-toolbar";
import { JOB_KINDS, JOB_STATES, jobKindLabel } from "../domain/job-rules";

const STATE_FILTERS = [
  { value: "all", label: "All" },
  ...JOB_STATES.map((state) => ({ value: state.value, label: state.word })),
];
const KIND_OPTIONS = [{ value: "all", label: "Any kind" }, ...JOB_KINDS];

/**
 * The Jobs toolbar (MD9): the state quick filters, the Filters popover with
 * Kind and its chip, and a quiet Refresh. The list API cannot search and
 * keeps one order, so there is no search and no Sort. The quick filters show
 * no counts: the API returns only the total of the current filter.
 */
export function JobsToolbar({
  kind,
  state,
  onKindChange,
  onStateChange,
  locked,
  refreshDisabled,
  onRefresh,
}: {
  /** The chosen kind, or "" for every kind. */
  kind: string;
  /** The chosen state, or "" for every state. */
  state: string;
  onKindChange: (kind: string) => void;
  onStateChange: (state: string) => void;
  /** True while a command or a read owns the filters. */
  locked: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
}) {
  const id = useId();
  const chips: FilterChip[] = kind
    ? [
        {
          key: "kind",
          label: "Kind",
          value: jobKindLabel(kind),
          onRemove: () => onKindChange(""),
        },
      ]
    : [];
  // Refresh sits beside the toolbar, so on a phone it stays on the Filters
  // row instead of wrapping to its own line. Below 1280px the state strip
  // scrolls sideways with the fade, so Filters keeps its line (MD19).
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <AccessToolbar
          search={false}
          searchLabel="Jobs"
          chips={chips}
          onClearFilters={() => onKindChange("")}
          filtersDisabled={locked}
          quickFiltersScroll
          quickFilters={
            <ToggleGroup
              aria-label="Job state"
              variant="segmented"
              multiple={false}
              disabled={locked}
              value={[state || "all"]}
              className="w-full max-w-full flex-nowrap overflow-x-auto max-xl:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-xl:pr-8 xl:w-fit [&>*]:shrink-0"
              onValueChange={(selection) => {
                const next = STATE_FILTERS.find(
                  (option) => option.value === selection[0],
                );
                if (next) onStateChange(next.value === "all" ? "" : next.value);
              }}
            >
              {STATE_FILTERS.map((option) => (
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
        >
          <FilterSelect
            id={`${id}-kind`}
            label="Kind"
            ariaLabel="Job kind"
            value={kind || "all"}
            options={KIND_OPTIONS}
            onChange={(value) => onKindChange(value === "all" ? "" : value)}
          />
        </AccessToolbar>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 xl:size-8"
              aria-label="Refresh Jobs"
              disabled={refreshDisabled}
              onClick={onRefresh}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          }
        />
        <TooltipContent>Refresh Jobs</TooltipContent>
      </Tooltip>
    </div>
  );
}
