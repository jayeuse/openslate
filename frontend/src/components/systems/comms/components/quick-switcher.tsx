"use client";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useUserPreferences } from "@/components/theme-provider";
import { COMMS_SHORTCUTS } from "@/lib/shortcuts";
import type { SidebarRow } from "../state/use-comms-sidebar";

export function QuickSwitcher({
  rows,
  select,
}: {
  rows: SidebarRow[];
  select: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const { keyboardShortcuts } = useUserPreferences();
  const opener = useRef<HTMLElement | null>(null);
  function show() {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSearch("");
    setOpen(true);
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        !keyboardShortcuts ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== COMMS_SHORTCUTS.switchConversation.key ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      show();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keyboardShortcuts]);
  const matches = rows.filter(
    (row) =>
      !row.preferences.hidden &&
      row.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <Button
        variant="ghost"
        className="min-h-11 w-full justify-start"
        onClick={show}
      >
        <Search className="size-4" />
        Switch conversation
        <span className="text-muted-foreground ml-auto text-xs">Ctrl/⌘K</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent finalFocus={() => opener.current}>
          <DialogTitle>Switch conversation</DialogTitle>
          <DialogDescription>
            Find a conversation in this organization.
          </DialogDescription>
          <Input
            aria-label="Find a conversation"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="my-3 min-h-11 sm:min-h-0"
          />
          <div className="max-h-80 overflow-y-auto">
            {matches.map((row) => (
              <Button
                key={row.conversation.id}
                variant="ghost"
                className="min-h-11 w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  select(row.conversation.id);
                }}
              >
                {row.name}
              </Button>
            ))}
            {!matches.length && (
              <p className="text-muted-foreground py-4 text-sm">
                No conversations match.
              </p>
            )}
          </div>
          <Button
            className="min-h-11 sm:min-h-0"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
