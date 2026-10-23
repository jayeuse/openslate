"use client";

import { useState, type Ref } from "react";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { SandboxTrigger } from "../domain/document";
import {
  TriggerEventIcon,
  triggerEventLabel,
  triggerStatusWord,
} from "./trigger-flow";

// The list pane of Triggers (docs/specs/sandbox-relayout.md S6, S7): the
// count and New trigger in the head, a search and the All, On, and Off quick
// filters, then one 40px row per trigger: a dot and a word for its state,
// the name on one line, and the event as a mark and a word.

export type TriggerStatusFilter = "all" | "on" | "off";

const statusFilters: { value: TriggerStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/** The name a trigger shows; a trigger with no name is "Untitled trigger". */
export function triggerDisplayName(recordTrigger: SandboxTrigger): string {
  return recordTrigger.name || "Untitled trigger";
}

/** The quick-filter counts: totals of the whole list, not of the search. */
export function triggerStatusCounts(
  triggers: readonly SandboxTrigger[],
): Record<TriggerStatusFilter, number> {
  const on = triggers.filter((item) => item.enabled).length;
  return { all: triggers.length, on, off: triggers.length - on };
}

/** The rows to show: the state filter, then the name or event word. */
export function filterTriggers(
  triggers: readonly SandboxTrigger[],
  { query, status }: { query: string; status: TriggerStatusFilter },
): SandboxTrigger[] {
  const needle = query.trim().toLowerCase();
  return triggers.filter(
    (item) =>
      (status === "all" || item.enabled === (status === "on")) &&
      (!needle ||
        triggerDisplayName(item).toLowerCase().includes(needle) ||
        triggerEventLabel(item).toLowerCase().includes(needle)),
  );
}

/** The state as a dot and a word: a filled flow dot for On, a ring for Off. */
function TriggerStatusMark({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap",
        enabled ? "text-flow-text" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          enabled
            ? "bg-[var(--flow)]"
            : "shadow-[inset_0_0_0_1.5px_var(--ink-muted)]",
        )}
      />
      {triggerStatusWord(enabled)}
    </span>
  );
}

export function TriggerList({
  listRef,
  triggers,
  selectedId,
  unsaved,
  phone,
  canCreate,
  onOpen,
  onCreate,
}: {
  listRef: Ref<HTMLElement>;
  triggers: readonly SandboxTrigger[];
  selectedId: string;
  /** Ids of triggers that Save will write (new or changed). */
  unsaved: ReadonlySet<string>;
  phone: boolean;
  canCreate: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TriggerStatusFilter>("all");
  const counts = triggerStatusCounts(triggers);
  const rows = filterTriggers(triggers, { query, status });
  return (
    <aside
      ref={listRef}
      aria-label="Trigger list"
      className="bg-card border-border flex min-w-0 flex-col overflow-clip rounded-xl border @min-[900px]/studio:h-full"
    >
      <div className="border-border flex min-h-14 items-center gap-2.5 border-b px-4 py-2">
        <h2
          data-slot="section-title"
          id="trigger-studio-title"
          className="font-semibold"
        >
          Triggers
        </h2>
        <span className="text-muted-foreground text-sm tabular-nums">
          {triggers.length}
        </span>
        <Button
          variant="ghost"
          className="ml-auto min-h-11"
          onClick={() => {
            // A new trigger is On and unnamed, so it shows whatever the
            // search and filter were.
            setQuery("");
            setStatus("all");
            onCreate();
          }}
          disabled={!canCreate}
        >
          <Plus aria-hidden="true" />
          New trigger
        </Button>
      </div>
      <div className="border-border flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-40 flex-1">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            aria-label="Search triggers"
            placeholder="Search triggers"
            className="min-h-11 pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ToggleGroup
          aria-label="Status"
          variant="segmented"
          multiple={false}
          value={[status]}
          className="w-fit flex-nowrap [&>*]:shrink-0"
          onValueChange={(selection) => {
            const next = statusFilters.find(
              (filter) => filter.value === selection[0],
            );
            if (next) setStatus(next.value);
          }}
        >
          {statusFilters.map((filter) => (
            <ToggleGroupItem
              key={filter.value}
              value={filter.value}
              className="flex-none gap-1.5 px-2 text-sm whitespace-nowrap"
            >
              {filter.label}{" "}
              <span className="text-muted-foreground font-normal tabular-nums">
                {counts[filter.value]}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <nav
        aria-label="Trigger list"
        className={cn(
          "min-h-0 @min-[900px]/studio:flex-1 @min-[900px]/studio:overflow-y-auto",
          !phone && "max-h-64 overflow-y-auto @min-[900px]/studio:max-h-none",
        )}
      >
        {rows.map((recordTrigger) => {
          const name = triggerDisplayName(recordTrigger);
          return (
            <Button
              key={recordTrigger.id}
              variant="ghost"
              data-trigger-row
              aria-current={
                recordTrigger.id === selectedId ? "true" : undefined
              }
              className={cn(
                // One line per row, 40px from 1280px (DESIGN "Access rows").
                // Hover and open tints come from the look's ink, so both read
                // in every look, light and dark; the open row also takes an
                // action edge.
                "border-border grid h-auto min-h-11 w-full min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] items-center justify-normal gap-2.5 rounded-none border-b px-3 py-0 text-left font-normal whitespace-nowrap max-sm:min-h-13 xl:h-10 xl:min-h-10",
                "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] aria-[current=true]:bg-[color-mix(in_oklab,var(--ink)_14%,transparent)] aria-[current=true]:shadow-[inset_2px_0_0_var(--action)]",
              )}
              onClick={() => onOpen(recordTrigger.id)}
            >
              <TriggerStatusMark enabled={recordTrigger.enabled} />
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium" title={name}>
                  {name}
                </span>
                {/* Which triggers Save will write (the Build field-row
                    pattern). */}
                {unsaved.has(recordTrigger.id) ? (
                  <Badge variant="warning" className="shrink-0">
                    Unsaved
                  </Badge>
                ) : null}
              </span>
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
                <TriggerEventIcon
                  kind={recordTrigger.trigger.kind}
                  className="size-3.5 shrink-0"
                />
                {triggerEventLabel(recordTrigger)}
              </span>
            </Button>
          );
        })}
        {triggers.length && !rows.length ? (
          <p className="text-muted-foreground p-4 text-sm">
            No triggers match.
          </p>
        ) : null}
      </nav>
    </aside>
  );
}
