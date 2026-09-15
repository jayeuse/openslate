"use client";

import * as React from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
} from "react-day-picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// shadcn Calendar composition, adapted to this project's existing primitives.
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaults = getDefaultClassNames();
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "bg-background group/calendar w-fit p-3 [--cell-size:2.75rem]",
        className,
      )}
      classNames={{
        root: defaults.root,
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "flex w-full flex-col gap-4",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between gap-1",
        button_previous:
          "hover:bg-muted focus-visible:outline-ring size-(--cell-size) rounded-md p-2 outline-none focus-visible:outline-2 aria-disabled:opacity-50",
        button_next:
          "hover:bg-muted focus-visible:outline-ring size-(--cell-size) rounded-md p-2 outline-none focus-visible:outline-2 aria-disabled:opacity-50",
        month_caption:
          "flex h-(--cell-size) items-center justify-center px-(--cell-size)",
        caption_label: "text-sm font-medium",
        dropdowns:
          "flex h-(--cell-size) items-center justify-center gap-2 text-sm font-medium",
        dropdown_root: "border-input relative rounded-md border",
        dropdown: "bg-popover absolute inset-0 opacity-0",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-muted-foreground flex-1 text-xs font-normal",
        week: "mt-1 flex w-full",
        day: "group/day relative size-(--cell-size) p-0 text-center",
        today: "bg-accent text-accent-foreground rounded-md",
        outside: "text-muted-foreground opacity-60",
        disabled: "text-muted-foreground opacity-40",
        hidden: "invisible",
        range_start: "bg-accent rounded-l-md",
        range_end: "bg-accent rounded-r-md",
        range_middle: "bg-accent",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="size-4" />
          ) : orientation === "right" ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          ),
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  );
}

export function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString()}
      data-selected={modifiers.selected}
      className={cn(
        "data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground size-(--cell-size) rounded-md font-normal",
        className,
      )}
      {...props}
    />
  );
}
