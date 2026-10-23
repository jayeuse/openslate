"use client";

import { useLayoutEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  attentionCountLabel,
  type BuildAttentionIssue,
} from "../domain/build-summary";
import type { SandboxValidationIssue } from "../domain/validation-types";
import { AttentionRow } from "./designer-summary";

const REVIEW_UNUSED = { reason: null, disabled: false } as const;

/**
 * What needs attention, folded into the header (docs/specs/sandbox-relayout.md
 * S18): one quiet button in warn ink beside the save-state chip, and a
 * popover that lists each item in the Build Summary row grammar with the
 * action that opens it. With nothing to attend to, there is no button. A
 * polite live region says a new count, as the old banner's status did, but
 * not on the first load.
 */
export function SandboxAttention({
  issues,
  settled,
  returnFocus,
  onOpen,
}: {
  issues: readonly BuildAttentionIssue[];
  /** The page has loaded, so a later count change is news. */
  settled: boolean;
  /** Where focus goes when the last item goes while the list is open. */
  returnFocus: () => HTMLElement | null;
  onOpen: (issue: SandboxValidationIssue) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = attentionCountLabel(issues.length);
  const emptied = label === null;
  // The count seen once the page settled; a different count is announced.
  const [seen, setSeen] = useState<{ label: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  if (settled && seen === null) setSeen({ label });
  else if (seen !== null && seen.label !== label) {
    setSeen({ label });
    setAnnouncement(label ?? "Nothing needs attention");
  }
  // The last item went while the list was open: move focus to the section
  // title first, then close, so focus never falls to the page body.
  useLayoutEffect(() => {
    if (!(emptied && open)) return;
    returnFocus()?.focus();
    setOpen(false);
  }, [emptied, open, returnFocus]);
  const live = (
    <span
      data-sandbox-attention-live
      role="status"
      aria-live="polite"
      className="sr-only"
    >
      {announcement}
    </span>
  );
  if (emptied && !open) return live;
  return (
    <>
      {live}
      <Popover open={open && !emptied} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-warn-text min-h-11 px-2 xl:min-h-8"
            />
          }
        >
          <TriangleAlert aria-hidden="true" />
          {label}
        </PopoverTrigger>
        <PopoverContent
          aria-label="Needs attention"
          // A pointer open leaves focus on the button (Tab enters the rows);
          // a keyboard open moves it to the first row, as Access Filters do.
          initialFocus={(type) => type === "keyboard"}
          // With nothing left, focus has already moved to the title.
          finalFocus={emptied ? false : true}
          align="start"
          collisionPadding={16}
          className="slim-ui w-[420px] max-w-[calc(100vw-2rem)] gap-0 p-0"
        >
          <ul className="divide-border max-h-[min(24rem,60dvh)] divide-y overflow-y-auto px-3">
            {issues.map((issue) => (
              <AttentionRow
                key={issue.key}
                item={{
                  key: issue.key,
                  kind: "issue",
                  count: null,
                  text: issue.message,
                  verb: issue.verb,
                  tone: "warn",
                  target: null,
                  issue: issue.issue,
                }}
                pending={false}
                review={REVIEW_UNUSED}
                describe
                onAction={() => {
                  setOpen(false);
                  onOpen(issue.issue);
                }}
              />
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </>
  );
}
