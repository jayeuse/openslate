import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { relationshipKind } from "../domain/model";

export interface RelationshipRow {
  id: string;
  name: string;
  direction: "outgoing" | "incoming";
  /** The module at the other end. */
  otherModule: string;
  cardinality: string;
  /** Closed relationships accept no new links until reopened. */
  closed?: boolean;
  /**
   * A live relationship's Close or Reopen and Permanently delete; null for
   * one that exists only in the draft.
   */
  lifecycle: {
    closed: boolean;
    canPurge: boolean;
    disabled: boolean;
  } | null;
}

/**
 * A module's relationships as compact rows: the name, the module at the
 * other end with an arrow for the direction, and one quiet ⋯ menu with the
 * row's actions: Edit, Close or Reopen (live ones), Permanently delete (a
 * closed live one), and Delete. This is the module's one relationships list
 * (docs/specs/sandbox-relayout.md S12).
 */
export function RelationshipList({
  rows,
  pending,
  onEdit,
  onToggleLifecycle,
  onPurge,
  onDelete,
}: {
  rows: readonly RelationshipRow[];
  pending: boolean;
  onEdit: (id: string) => void;
  onToggleLifecycle: (id: string) => void;
  onPurge: (id: string) => void;
  /** Opens the delete confirmation; focus returns to the row's menu. */
  onDelete: (id: string, opener: HTMLElement | null) => void;
}) {
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground text-sm">No relationships yet.</p>
    );
  return (
    <ul className="divide-border divide-y">
      {rows.map((row) => {
        const menuId = `sandbox-relationship-${row.direction}-${row.id}`;
        const verb = row.lifecycle?.closed ? "Reopen" : "Close";
        return (
          <li
            key={`${row.direction}:${row.id}`}
            className="flex min-h-11 items-center gap-2 py-1 xl:min-h-10"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <span className="truncate" title={row.name}>
                  {row.name}
                </span>
                {row.closed ? <Badge variant="outline">Closed</Badge> : null}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                <span aria-hidden="true">
                  {row.direction === "outgoing" ? "→ " : "← "}
                </span>
                <span className="sr-only">
                  {row.direction === "outgoing" ? "To " : "From "}
                </span>
                {row.otherModule} · {relationshipKind(row.cardinality).label}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    id={menuId}
                    size="icon"
                    variant="ghost"
                    className="size-11 shrink-0 xl:size-8"
                    aria-label={`Actions for relationship ${row.name}, ${row.direction}`}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent
                data-sandbox-portal
                align="end"
                className="slim-ui min-w-44"
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    className="min-h-11 xl:min-h-0"
                    aria-label={`Edit ${row.direction} relationship ${row.name}`}
                    onClick={() => onEdit(row.id)}
                  >
                    <Pencil aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                  {row.lifecycle ? (
                    <DropdownMenuItem
                      className="min-h-11 xl:min-h-0"
                      disabled={row.lifecycle.disabled}
                      aria-label={`${verb} relationship ${row.name}, ${row.direction}`}
                      onClick={() => onToggleLifecycle(row.id)}
                    >
                      {verb}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {row.lifecycle?.canPurge ? (
                    <DropdownMenuItem
                      variant="destructive"
                      className="min-h-11 xl:min-h-0"
                      disabled={row.lifecycle.disabled}
                      aria-label={`Permanently delete relationship ${row.name}, ${row.direction}`}
                      onClick={() => onPurge(row.id)}
                    >
                      Permanently delete
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    className="min-h-11 xl:min-h-0"
                    disabled={pending}
                    aria-label={`Delete relationship ${row.name}, ${row.direction}`}
                    onClick={() =>
                      onDelete(row.id, document.getElementById(menuId))
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}
