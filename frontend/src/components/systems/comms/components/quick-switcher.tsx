"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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

const noSubscription = () => () => {};
/** Apple keyboards say Command; the static export renders Ctrl until hydrated. */
function useAppleKeyboard() {
  return useSyncExternalStore(
    noSubscription,
    () => /mac|iphone|ipad/i.test(navigator.platform),
    () => false,
  );
}

export function QuickSwitcher({
  rows,
  select,
}: {
  rows: SidebarRow[];
  select: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const { keyboardShortcuts, disabled } = useUserPreferences();
  const apple = useAppleKeyboard();
  // The hint shows only while the shortcut works.
  const shortcut = keyboardShortcuts === true && !disabled;
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
        disabled ||
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
  }, [keyboardShortcuts, disabled]);
  const matches = rows.filter(
    (row) =>
      !row.preferences.hidden &&
      row.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <Button
        variant="ghost"
        className="@container min-h-11 w-full justify-start px-2"
        aria-keyshortcuts={shortcut ? "Control+K Meta+K" : undefined}
        title={
          shortcut
            ? `Switch conversation (${apple ? "⌘K" : "Ctrl+K"})`
            : undefined
        }
        onClick={show}
      >
        <Search className="size-4" />
        <span className="min-w-0 truncate">Switch conversation</span>
        {/* A touch screen has no keyboard to press it on. */}
        {shortcut && (
          <span className="ml-auto shrink-0 [@media(pointer:coarse)]:hidden">
            <kbd
              aria-hidden="true"
              className="text-muted-foreground hidden font-sans text-xs font-normal @min-[12.25rem]:inline"
            >
              {apple ? "⌘K" : "Ctrl K"}
            </kbd>
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          finalFocus={() => opener.current}
          className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
        >
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
