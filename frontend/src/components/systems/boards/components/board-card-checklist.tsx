"use client";

import { useId, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import { listCardActivity } from "../adapters/board-card-sheet-api";
import { kanbanKeys } from "../adapters/board-kanban-queries";
import type { ChecklistItem } from "../adapters/board-kanban-schemas";
import {
  MAX_CHECKLIST_ITEMS,
  canAddChecklistItem,
  checklistCount,
} from "../domain/card-sheet";
import type { CardFieldContext } from "./board-card-fields";

const control = "min-h-11 xl:min-h-8";

/**
 * An objective's checklist (BR64): tick, add, rename, move and delete, at
 * most 50 items, counted "3/5". Move up and Move down are the keyboard path
 * for its order (WCAG 2.5.7).
 */
export function CardChecklist({ context }: { context: CardFieldContext }) {
  const id = useId();
  const { model, canWrite } = context;
  const items = context.sheet.checklist;
  const count = checklistCount(items);
  const [text, setText] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(
    null,
  );
  // A tick shows at once; the saved item replaces it, or a refusal reads
  // the card again.
  const [ticking, setTicking] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const tick = (item: ChecklistItem, done: boolean) => {
    setTicking((current) => new Map(current).set(item.id, done));
    void model.checklist.tick(item, done).finally(() =>
      setTicking((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      }),
    );
  };
  const room = canAddChecklistItem(items);
  const busy = model.saving?.startsWith("checklist:") ?? false;
  const add = () => {
    const value = text.trim();
    if (!value || !room) return;
    void model.checklist.add(value).then((done) => {
      if (done) setText("");
    });
  };
  const done = items.filter((item) => item.done).length;
  return (
    <section aria-label="Checklist" className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold">
        Checklist
        {count ? (
          <span className="text-muted-foreground font-normal tabular-nums">
            {count}
          </span>
        ) : null}
      </h3>
      {items.length > 0 ? (
        <div
          aria-hidden="true"
          className="bg-muted h-1 overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground/60 h-full"
            style={{ width: `${(done / items.length) * 100}%` }}
          />
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="group/item flex min-h-11 items-center gap-2 xl:min-h-8"
            >
              {renaming?.id === item.id ? (
                <Input
                  autoFocus
                  aria-label={`Rename ${item.text}`}
                  maxLength={200}
                  className={control}
                  value={renaming.text}
                  onChange={(event) =>
                    setRenaming({
                      id: item.id,
                      text: event.currentTarget.value,
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setRenaming(null);
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const value = renaming.text.trim();
                    if (value && value !== item.text)
                      void model.checklist.rename(item, value);
                    setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-sm xl:min-h-8">
                  <input
                    type="checkbox"
                    className="accent-foreground size-4 shrink-0"
                    checked={ticking.get(item.id) ?? item.done}
                    disabled={!canWrite || ticking.has(item.id)}
                    onChange={(event) =>
                      tick(item, event.currentTarget.checked)
                    }
                  />
                  <span
                    className={cn(
                      "min-w-0 break-words",
                      (ticking.get(item.id) ?? item.done) &&
                        "text-muted-foreground line-through",
                    )}
                  >
                    {item.text}
                  </span>
                </label>
              )}
              {canWrite && renaming?.id !== item.id ? (
                <ItemMenu
                  item={item}
                  first={index === 0}
                  last={index === items.length - 1}
                  disabled={busy}
                  onRename={() => setRenaming({ id: item.id, text: item.text })}
                  onMove={(offset) =>
                    void model.checklist.move(items, item, offset)
                  }
                  onRemove={() => void model.checklist.remove(item)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : canWrite ? null : (
        <p className="text-muted-foreground text-sm">No checklist.</p>
      )}
      {canWrite ? (
        room ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Input
              id={id}
              aria-label="New checklist item"
              placeholder="Add an item"
              maxLength={200}
              className={control}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="outline"
              className={cn(control, "shrink-0")}
              disabled={!text.trim() || model.saving === "checklist:new"}
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add item
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">
            A card has at most {MAX_CHECKLIST_ITEMS} checklist items.
          </p>
        )
      ) : null}
    </section>
  );
}

function ItemMenu({
  item,
  first,
  last,
  disabled,
  onRename,
  onMove,
  onRemove,
}: {
  item: ChecklistItem;
  first: boolean;
  last: boolean;
  disabled: boolean;
  onRename: () => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 xl:size-8"
            aria-label={`Checklist item actions, ${item.text}`}
            disabled={disabled}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="slim-ui min-w-40">
        <DropdownMenuItem className={control} onClick={onRename}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          className={control}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          className={control}
          disabled={last}
          onClick={() => onMove(1)}
        >
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          className={control}
          onClick={onRemove}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The card's activity from the audit log (BR81), newest first. */
export function CardActivityList({
  boardId,
  cardId,
  region,
}: {
  boardId: string;
  cardId: string;
  region: WorkspaceRegion;
}) {
  const activity = useInfiniteQuery({
    queryKey: [...kanbanKeys.card(boardId, cardId), "activity"],
    queryFn: ({ pageParam, signal }) =>
      listCardActivity(boardId, cardId, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.hasMore
        ? pages.reduce((sum, page) => sum + page.items.length, 0)
        : undefined,
    staleTime: 0,
  });
  if (activity.isPending)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading activity…
      </p>
    );
  if (activity.isError)
    return (
      <Alert
        variant="destructive"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <span>The activity could not be loaded.</span>
        <Button
          type="button"
          variant="outline"
          className={control}
          onClick={() => void activity.refetch()}
        >
          Retry
        </Button>
      </Alert>
    );
  const rows = activity.data.pages.flatMap((page) => page.items);
  if (rows.length === 0)
    return <p className="text-muted-foreground text-sm">No activity yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y text-sm">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-baseline gap-x-2 py-2"
          >
            <span className="font-medium">{row.summary}</span>
            <span className="text-muted-foreground text-xs">
              {[row.actor, formatWorkspaceDateTime(row.at, region)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {activity.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className={cn(control, "self-start")}
          disabled={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          Show more activity
        </Button>
      ) : null}
    </div>
  );
}
