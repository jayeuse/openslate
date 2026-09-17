import type { ReactNode } from "react";

import { Empty, EmptyDescription } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { Action } from "../../shared/components/ui";

export type CommsThreadFilter = "active" | "inactive";

export interface CommsThreadListItem {
  id: string;
  title: string;
  inactive: boolean;
  metadata: ReactNode;
}

export interface CommsThreadListProps {
  items: readonly CommsThreadListItem[];
  filter: CommsThreadFilter;
  onFilterChange: (filter: CommsThreadFilter) => void;
  onSelect: (item: CommsThreadListItem) => void;
  emptyDescription: string;
  filterClassName?: string;
}

export function filterCommsThreadItems(
  items: readonly CommsThreadListItem[],
  filter: CommsThreadFilter,
): CommsThreadListItem[] {
  return items.filter((item) => item.inactive === (filter === "inactive"));
}

/** Shared active/inactive filter and card presentation for Comms thread lists. */
export function CommsThreadList({
  items,
  filter,
  onFilterChange,
  onSelect,
  emptyDescription,
  filterClassName,
}: CommsThreadListProps) {
  const visibleItems = filterCommsThreadItems(items, filter);

  return (
    <>
      <ToggleGroup
        className={filterClassName}
        value={[filter]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "active" || next === "inactive") {
            onFilterChange(next);
          }
        }}
      >
        <ToggleGroupItem value="active">Active</ToggleGroupItem>
        <ToggleGroupItem value="inactive">Inactive</ToggleGroupItem>
      </ToggleGroup>
      <div className="flex flex-col gap-1">
        {visibleItems.map((item) => (
          <Action
            type="button"
            key={item.id}
            className="h-auto w-full flex-col items-start gap-1 p-3 text-left whitespace-normal"
            onClick={() => onSelect(item)}
          >
            <span className="line-clamp-2 text-sm">{item.title}</span>
            <span className="text-muted-foreground text-xs">
              {item.metadata}
            </span>
          </Action>
        ))}
        {visibleItems.length === 0 ? (
          <Empty>
            <EmptyDescription>{emptyDescription}</EmptyDescription>
          </Empty>
        ) : null}
      </div>
    </>
  );
}
