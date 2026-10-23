"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BuildAttentionIssue } from "../domain/build-summary";
import type { SandboxValidationIssue } from "../domain/validation-types";
import { SandboxAttention } from "./sandbox-attention";

/**
 * Undo or Redo: a quiet icon button whose tooltip names it. With nothing to
 * step through, it stays focusable and its tooltip says why instead.
 */
function HistoryButton({
  label,
  busy,
  emptyReason,
  onClick,
  children,
}: {
  label: string;
  busy: boolean;
  emptyReason: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      className="max-xl:size-11"
      disabled={busy || emptyReason !== null}
      onClick={onClick}
    >
      {children}
    </Button>
  );
  if (!busy && emptyReason !== null)
    return <DisabledReason reason={emptyReason}>{button}</DisabledReason>;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Build's Undo and Redo; the header shows them from 768px, the canvas toolbar below. */
export function SandboxHistoryButtons({
  busy,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <>
      <HistoryButton
        label="Undo"
        busy={busy}
        emptyReason={canUndo ? null : "Nothing to undo."}
        onClick={onUndo}
      >
        <Undo2 />
      </HistoryButton>
      <HistoryButton
        label="Redo"
        busy={busy}
        emptyReason={canRedo ? null : "Nothing to redo."}
        onClick={onRedo}
      >
        <Redo2 />
      </HistoryButton>
    </>
  );
}

/**
 * The Sandbox header (docs/specs/sandbox-relayout.md S2, S13, S18). The title
 * names the section; under it sit the save-state chip and the attention
 * control. Below 768px it is two rows: the title with Review & Publish and
 * the menu, then the chip and attention (Undo and Redo move to the Build
 * canvas toolbar). From 768px the title row wraps above the buttons; from
 * 1280px the title block and the buttons share one row.
 */
export function SandboxPageHeader({
  section,
  publishCount,
  chip,
  attention,
  history,
  review,
  menu,
}: {
  section: string;
  /** Replays the title signature after each publish. */
  publishCount: number;
  /** The save-state chip, or null while the page first loads. */
  chip: {
    text: string;
    /** The phone words ("Unpublished · Saved"); `text` stays the content. */
    short: string;
    variant: "destructive" | "warning" | "outline";
  } | null;
  attention: {
    issues: readonly BuildAttentionIssue[];
    onOpen: (issue: SandboxValidationIssue) => void;
  };
  /** Undo and Redo on Build; null elsewhere. */
  history: ReactNode;
  review: { reason: string | null; disabled: boolean; open: () => void };
  /** The ⋯ menu. */
  menu: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useCallback(() => titleRef.current, []);
  return (
    <header className="slim-ui grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:flex md:flex-col md:items-stretch md:gap-3 xl:flex-row xl:items-end xl:justify-between xl:gap-4">
      {/* Below 768px this block dissolves into the header grid, so the
          title takes row 1 beside the buttons and the status line row 2. */}
      <div className="contents md:flex md:min-w-0 md:flex-wrap md:items-center md:gap-x-3 md:gap-y-1 xl:flex-col xl:items-start">
        <h1
          key={publishCount}
          ref={titleRef}
          // Takes focus when the attention list empties while open.
          tabIndex={-1}
          data-slot="page-title"
          data-signature={publishCount > 0 ? "play" : undefined}
          className="min-w-0 text-xl font-semibold tracking-tight outline-none max-md:col-start-1 max-md:row-start-1 sm:text-2xl"
        >
          {section}
        </h1>
        <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 max-md:col-span-2 max-md:row-start-2 xl:min-h-8">
          {chip ? (
            // One save-state chip: the publish state, then what is
            // happening to the draft right now (the Four Moments Rule).
            // Below 640px it shows short words, drawn by CSS with an empty
            // alternative, so the full words stay its text for assistive
            // technology and the phone header keeps two rows (S27).
            <Badge
              data-sandbox-save-state
              data-short={chip.short}
              role="status"
              variant={chip.variant}
              className='max-sm:before:[content:attr(data-short)_/_""]'
            >
              <span className="max-sm:sr-only">{chip.text}</span>
            </Badge>
          ) : null}
          <SandboxAttention
            issues={attention.issues}
            settled={chip !== null}
            returnFocus={returnFocus}
            onOpen={attention.onOpen}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-md:col-start-2 max-md:row-start-1">
        {history ? (
          <div className="flex gap-2 max-md:hidden">{history}</div>
        ) : null}
        <DisabledReason reason={review.reason}>
          <Button
            className="min-h-11 max-md:px-3"
            disabled={review.disabled}
            onClick={review.open}
          >
            Review &amp; Publish
          </Button>
        </DisabledReason>
        {menu}
      </div>
    </header>
  );
}
