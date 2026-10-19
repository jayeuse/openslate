"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

/** Only a disclosure preference is persisted; never a draft or authority. */
export function SettingsAdvanced({
  storageKey,
  count,
  children,
  searching = false,
}: {
  storageKey: string;
  count: number;
  children: ReactNode;
  searching?: boolean;
}) {
  const [open, setOpen] = useState(searching);
  useEffect(() => {
    if (searching) {
      setOpen(true);
      return;
    }
    try {
      setOpen(localStorage.getItem(storageKey) === "true");
    } catch {
      /* Storage may be unavailable; disclosure remains usable in memory. */
    }
  }, [storageKey, searching]);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        try {
          if (!searching) localStorage.setItem(storageKey, String(next));
        } catch {
          /* Saving settings does not depend on a layout preference. */
        }
      }}
      className="border-card-edge rounded-md border"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="min-h-11 w-full justify-start px-3"
          />
        }
      >
        <ChevronRight
          aria-hidden="true"
          className={open ? "rotate-90" : undefined}
        />
        <span className="mr-auto">Advanced settings</span>
        <span className="text-muted-foreground text-xs font-normal">
          {count} changed
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-5 border-t p-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
