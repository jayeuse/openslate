"use client";

import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GanttGroup, GanttZoom } from "../domain/gantt";

const ZOOMS: { value: GanttZoom; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
];
const GROUPS: { value: GanttGroup; label: string }[] = [
  { value: "stage", label: "Stage" },
  { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" },
];
const UNIT: Record<GanttZoom, string> = {
  week: "week",
  month: "month",
  quarter: "quarter",
};

/**
 * One toolbar row (BR72, BR75): previous, next, the period, Today, then
 * Zoom and Group by. Phones wrap Zoom onto its own row and group by stage,
 * as the comp draws them (BR76).
 */
export function GanttToolbar({
  title,
  zoom,
  group,
  onPrevious,
  onNext,
  onToday,
  onZoom,
  onGroup,
}: {
  title: string;
  zoom: GanttZoom;
  group: GanttGroup;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onZoom: (zoom: GanttZoom) => void;
  onGroup: (group: GanttGroup) => void;
}) {
  const groupLabel = GROUPS.find((option) => option.value === group)?.label;
  return (
    <div
      role="group"
      aria-label="Gantt"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2"
    >
      <span className="flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 xl:size-8"
          aria-label={`Previous ${UNIT[zoom]}`}
          onClick={onPrevious}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 xl:size-8"
          aria-label={`Next ${UNIT[zoom]}`}
          onClick={onNext}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </span>
      <h2
        data-slot="section-title"
        aria-live="polite"
        className="min-w-0 text-lg font-semibold whitespace-nowrap tabular-nums"
      >
        {title}
      </h2>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 max-md:ml-auto xl:min-h-8"
        onClick={onToday}
      >
        Today
      </Button>
      <span className="hidden flex-1 md:block" />
      <ToggleGroup
        aria-label="Zoom"
        variant="segmented"
        multiple={false}
        value={[zoom]}
        className="gap-0.5 p-0.5 max-md:order-90 max-md:w-full md:w-auto"
        onValueChange={(selection) => {
          const next = ZOOMS.find((option) => option.value === selection[0]);
          if (next) onZoom(next.value);
        }}
      >
        {ZOOMS.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="px-3 text-sm whitespace-nowrap md:flex-none xl:px-2.5"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="min-h-11 max-md:hidden xl:min-h-8"
              aria-label={`Group by: ${groupLabel}`}
            />
          }
        >
          <span className="text-muted-foreground">Group by:</span>
          {groupLabel}
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="slim-ui">
          {GROUPS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === group}
              className="min-h-11 xl:min-h-8"
              onClick={() => onGroup(option.value)}
            >
              {option.label}
              {option.value === group ? (
                <Check aria-hidden="true" className="ml-auto" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
