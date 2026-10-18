"use client";

import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "openslate:advanced:";

type OpenStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Whether this viewer left the Advanced block open; storage may be absent. */
export function readAdvancedOpen(
  key: string,
  storage: OpenStore | null = typeof window === "undefined"
    ? null
    : window.localStorage,
): boolean {
  try {
    return storage?.getItem(STORAGE_PREFIX + key) === "open";
  } catch {
    return false;
  }
}

export function writeAdvancedOpen(
  key: string,
  open: boolean,
  storage: OpenStore | null = typeof window === "undefined"
    ? null
    : window.localStorage,
): void {
  try {
    if (open) storage?.setItem(STORAGE_PREFIX + key, "open");
    else storage?.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Private windows and blocked storage keep the default (closed).
  }
}

export interface AdvancedSectionProps {
  /** Stable per panel, so each panel remembers its own state. */
  storageKey: string;
  /** Controls inside whose value differs from the default. */
  setCount?: number;
  children: ReactNode;
  className?: string;
}

/**
 * The one place for a panel's less common controls (the Advanced Last Rule,
 * DESIGN.md): last in its panel, closed by default, remembered per viewer,
 * and counting what is set while closed so nothing changes out of sight.
 */
export function AdvancedSection({
  storageKey,
  setCount = 0,
  children,
  className,
}: AdvancedSectionProps) {
  // Signed-in pages render in the browser, so the remembered state applies
  // on the first render and an expanded row never flashes closed.
  const [open, setOpen] = useState(() => readAdvancedOpen(storageKey));

  return (
    <Collapsible
      data-slot="advanced-section"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writeAdvancedOpen(storageKey, next);
      }}
      className={cn("border-border border-t pt-2", className)}
    >
      <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground focus-visible:outline-ring flex min-h-9 w-full items-center gap-1.5 rounded-sm text-sm font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:outline-2">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-(--motion-fast) group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
        />
        <span>Advanced</span>
        {!open && setCount > 0 ? (
          <span className="text-xs font-normal"> · {setCount} set</span>
        ) : null}
      </CollapsibleTrigger>
      {/* Kept mounted (hidden while closed) so every branch renders as soon
          as its panel does, and nothing inside resets when it opens. */}
      <CollapsibleContent keepMounted className="space-y-4 pt-2 pb-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
