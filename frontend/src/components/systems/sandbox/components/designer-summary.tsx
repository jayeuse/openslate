"use client";

import type { ReactNode } from "react";
import {
  Check,
  CloudUpload,
  LayoutGrid,
  Plus,
  TableProperties,
  TriangleAlert,
  ZapOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { cn } from "@/lib/utils";
import type {
  BuildAttentionItem,
  BuildAttentionKind,
} from "../domain/build-summary";

// Build with nothing selected (docs/specs/sandbox-relayout.md S12): one fact
// line of counts, then what needs attention in the Access overview grammar (a
// toned icon, a bold count, the words, one verb), or "All clear", then the
// quiet ways to add to the design.

const attentionIcons: Record<BuildAttentionKind, ReactNode> = {
  unpublished: <CloudUpload />,
  triggersOff: <ZapOff />,
  emptyModules: <TableProperties />,
  overlaps: <LayoutGrid />,
  issue: <TriangleAlert />,
};

export function DesignerSummary({
  facts,
  items,
  review,
  pending,
  designIsEmpty,
  onAction,
  onAddDepartment,
  onStartFromTemplate,
}: {
  /** The design's counts, as one line. */
  facts: string;
  items: readonly BuildAttentionItem[];
  /** Why the Review row cannot open Review & Publish now, when it cannot. */
  review: { reason: string | null; disabled: boolean };
  pending: boolean;
  designIsEmpty: boolean;
  onAction: (item: BuildAttentionItem) => void;
  onAddDepartment: () => void;
  onStartFromTemplate: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 data-slot="section-title" className="text-lg font-semibold">
          Summary
        </h2>
        <p className="text-muted-foreground text-sm">{facts}</p>
      </div>
      <section
        aria-labelledby="sandbox-attention-heading"
        className="flex flex-col gap-1.5"
      >
        <h3
          id="sandbox-attention-heading"
          data-slot="section-title"
          className="text-sm font-semibold"
        >
          Needs attention
        </h3>
        {items.length ? (
          <ul className="divide-border border-border divide-y border-y">
            {items.map((item) => (
              <AttentionRow
                key={item.key}
                item={item}
                pending={pending}
                review={review}
                onAction={onAction}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Check
              aria-hidden="true"
              className="size-4 shrink-0 text-[var(--flow-text)]"
            />
            All clear
          </p>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="max-xl:min-h-11"
          disabled={pending}
          onClick={onAddDepartment}
        >
          <Plus aria-hidden="true" />
          Add department
        </Button>
        {designIsEmpty ? (
          <Button
            variant="ghost"
            size="sm"
            className="max-xl:min-h-11"
            disabled={pending}
            onClick={onStartFromTemplate}
          >
            Start from a template
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AttentionRow({
  item,
  pending,
  review,
  onAction,
}: {
  item: BuildAttentionItem;
  pending: boolean;
  review: { reason: string | null; disabled: boolean };
  onAction: (item: BuildAttentionItem) => void;
}) {
  const words = item.count === null ? item.text : `${item.count} ${item.text}`;
  // Review opens Review & Publish only when the header button could; it
  // gives the same reason. The other rows wait while a change saves.
  const disabled = item.kind === "unpublished" ? review.disabled : pending;
  const reason = item.kind === "unpublished" ? review.reason : null;
  return (
    <li
      data-tone={item.tone}
      className="grid min-h-14 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 py-1 text-sm xl:min-h-10"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-7 place-items-center rounded-sm [&_svg]:size-4",
          item.tone === "warn"
            ? "bg-[var(--warn-tint)] text-[var(--warn-text)]"
            : "bg-muted text-muted-foreground",
        )}
      >
        {attentionIcons[item.kind]}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {item.count === null ? (
          item.text
        ) : (
          <>
            <b className="font-semibold tabular-nums">{item.count}</b>{" "}
            {item.text}
          </>
        )}
      </span>
      <DisabledReason reason={reason}>
        <Button
          variant="ghost"
          className="min-h-11 px-3 xl:h-8 xl:min-h-8 xl:px-2.5"
          aria-label={`${item.verb}: ${words}`}
          disabled={disabled}
          onClick={() => onAction(item)}
        >
          {item.verb}
        </Button>
      </DisabledReason>
    </li>
  );
}
