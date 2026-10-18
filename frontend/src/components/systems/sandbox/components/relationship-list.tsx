import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface RelationshipRow {
  id: string;
  name: string;
  direction: "outgoing" | "incoming";
  /** The module at the other end. */
  otherModule: string;
  cardinality: string;
  /** Closed relationships accept no new links until reopened (Advanced). */
  closed?: boolean;
}

/**
 * A module's relationships as compact rows: the name, the module at the
 * other end with an arrow for the direction, and icon actions. Both
 * directions share one list, so one empty line covers the module.
 */
export function RelationshipList({
  rows,
  onEdit,
  onDelete,
}: {
  rows: readonly RelationshipRow[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground text-sm">No relationships yet.</p>
    );
  return (
    <ul className="divide-border divide-y">
      {rows.map((row) => (
        <li
          key={`${row.direction}:${row.id}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5"
        >
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{row.name}</span>
              {row.closed ? <Badge variant="outline">Closed</Badge> : null}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              <span aria-hidden="true">
                {row.direction === "outgoing" ? "→ " : "← "}
              </span>
              <span className="sr-only">
                {row.direction === "outgoing" ? "To " : "From "}
              </span>
              {row.otherModule} · {row.cardinality}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              size="icon"
              variant="ghost"
              className="size-11 xl:size-8"
              aria-label={`Edit ${row.direction} relationship ${row.name}`}
              title="Edit"
              onClick={() => onEdit(row.id)}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="hover:text-danger-text size-11 xl:size-8"
              aria-label={`Delete ${row.direction} relationship ${row.name}`}
              title="Delete"
              onClick={() => onDelete(row.id)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
