"use client";

import { Bell } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { useWorkspaceInteractionSuspended } from "../../shared/runtime/workspace-identity";
import {
  isWorkspaceStreamAvailable,
  subscribeWorkspaceInvalidations,
} from "../../shared/adapters/invalidation-events";
import {
  notificationCountOptions,
  notificationKeys,
  notificationPageOptions,
  notificationRefusalOptions,
  setNotificationAccountAvailable,
  refreshNotificationReads,
} from "../adapters/platform-queries";
import {
  NotificationItems,
  useNotificationCommands,
} from "./notification-items";

export function NotificationBell({ accountId }: { accountId: string | null }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [focusAccount, setFocusAccount] = useState<string | null>(null);
  const suspended = useWorkspaceInteractionSuspended();
  useLayoutEffect(() => {
    setNotificationAccountAvailable(client, Boolean(accountId) && !suspended);
    return () => setNotificationAccountAvailable(client, false);
  }, [accountId, client, suspended]);
  const count = useQuery({
    ...notificationCountOptions(),
    enabled: Boolean(accountId) && !suspended,
  });
  const refused = useQuery(notificationRefusalOptions()).data;
  const page = useQuery({
    ...notificationPageOptions("all", 10),
    enabled: Boolean(accountId) && open && !suspended,
  });
  const commands = useNotificationCommands();
  const knownCount = refused ? undefined : count.data;
  useEffect(() => {
    if (suspended) {
      void client.cancelQueries({ queryKey: notificationKeys.all });
      return;
    }
    if (!accountId || refused) return;
    return subscribeWorkspaceInvalidations(
      (event) => {
        if (
          event.type === "resync" ||
          [
            "in_app_notifications",
            "users",
            "group_members",
            "groups",
            "group_access",
            "departments",
            "modules",
            "workspace_profiles",
          ].includes(event.entity)
        )
          void refreshNotificationReads(client);
      },
      () => {
        void refreshNotificationReads(client);
      },
    );
  }, [accountId, client, refused, suspended]);
  useEffect(() => {
    if (!focusAccount) return;
    if (focusAccount !== accountId || refused) {
      setFocusAccount(null);
      return;
    }
    if (suspended) return;
    setFocusAccount(null);
    if (!isWorkspaceStreamAvailable())
      void refreshNotificationReads(client, notificationKeys.count);
  }, [accountId, client, focusAccount, refused, suspended]);
  useEffect(() => {
    if (!accountId || refused) return;
    const focus = () => {
      if (!isWorkspaceStreamAvailable()) setFocusAccount(accountId);
    };
    // Capture stream availability before the shell conceals the workspace;
    // the pending read waits for this same account to be admitted again.
    window.addEventListener("focus", focus, true);
    return () => window.removeEventListener("focus", focus, true);
  }, [accountId, refused]);
  const visiblePage = refused ? undefined : page.data;
  return (
    <Popover
      open={open}
      onOpenChange={(value, details) => {
        const inConfirmation = (target: EventTarget | null) =>
          target instanceof Element &&
          target.closest('[role="alertdialog"]:not([aria-modal="false"])') !==
            null;
        if (
          !value &&
          ["focus-out", "outside-press", "escape-key"].includes(
            details.reason,
          ) &&
          (inConfirmation(details.event.target) ||
            (details.event instanceof FocusEvent &&
              inConfirmation(details.event.relatedTarget)))
        ) {
          details.cancel();
          return;
        }
        setOpen(value);
        if (value) void refreshNotificationReads(client);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative size-11"
            disabled={!accountId}
            aria-label={
              knownCount === undefined
                ? "Notifications"
                : `Notifications, ${knownCount} unread`
            }
            title="Notifications"
          />
        }
      >
        <Bell
          className={
            knownCount && knownCount > 0 ? "size-4 translate-y-0.5" : "size-4"
          }
          aria-hidden="true"
        />
        {knownCount !== undefined && knownCount > 0 && (
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground absolute top-0 right-0 min-w-4 rounded-full px-1 text-xs leading-4 tabular-nums"
          >
            {knownCount > 99 ? "99+" : knownCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className="w-[min(25rem,calc(100vw-2rem))] gap-3 p-4"
        aria-label="Notifications"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PopoverTitle>Notifications</PopoverTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            disabled={Boolean(commands.pending) || refused || !knownCount}
            onClick={() => void commands.markAll()}
          >
            {commands.pending === "all"
              ? "Marking all as read…"
              : "Mark all as read"}
          </Button>
        </div>
        {count.isPending && !refused && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading unread count…
          </p>
        )}
        {(count.isError || page.isError || refused) && (
          <Alert
            role="alert"
            variant="destructive"
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <p className="min-w-0">
              {refused
                ? "Notifications are unavailable. Sign in or ask for access, then try again."
                : "Couldn’t load notifications."}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => {
                void count.refetch();
                void page.refetch();
              }}
            >
              Try again
            </Button>
          </Alert>
        )}
        <div
          className="max-h-[min(32rem,60dvh)] overflow-y-auto"
          aria-busy={page.isFetching}
        >
          {page.isFetching && !visiblePage && (
            <p role="status" className="text-muted-foreground py-4 text-sm">
              Loading notifications…
            </p>
          )}
          {visiblePage?.items.length === 0 && (
            <p className="text-muted-foreground py-4 text-sm">
              No notifications yet.
            </p>
          )}
          {visiblePage && (
            <NotificationItems
              items={visiblePage.items}
              compact
              commands={commands}
              onNavigate={() => setOpen(false)}
            />
          )}
        </div>
        <GuardedWorkspaceLink
          href="/platform?section=notifications"
          onAcceptedNavigate={() => setOpen(false)}
          className="text-primary inline-flex min-h-11 items-center border-t pt-2 text-sm font-medium underline underline-offset-4"
        >
          View all
        </GuardedWorkspaceLink>
      </PopoverContent>
    </Popover>
  );
}
