"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { ApiError } from "@/lib/api";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { Alert } from "@/components/ui/alert";
import { reportDone, reportError } from "@/lib/feedback";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import { manageWorkspaceOptions } from "../../manage/adapters/manage-queries";
import { useWorkspaceInteractionSuspended } from "../../shared/runtime/workspace-identity";
import { Action } from "../../shared/components/ui";
import {
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
} from "../../shared/adapters/notifications-api";
import {
  beginNotificationCommand,
  endNotificationCommand,
  notificationCommandOptions,
  isNotificationAccountAvailable,
  notificationReadRefused,
  notificationTitleOptions,
  refreshNotificationReads,
  refuseNotificationReads,
  resetNotificationPages,
} from "../adapters/platform-queries";

export function useNotificationCommands() {
  const client = useQueryClient();
  const pending = useQuery(notificationCommandOptions()).data;
  const suspended = useWorkspaceInteractionSuspended();
  const active = useRef(false);
  const allowed = useRef(!suspended);
  useLayoutEffect(() => {
    allowed.current = !suspended;
  }, [suspended]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run(id: string | null) {
    const command = id ?? "all";
    if (!allowed.current || !beginNotificationCommand(client, command)) return;
    try {
      if (id) await markNotificationRead(id);
      else await markAllNotificationsRead();
      // Reconcile this account even if its initiating inbox left. The shell
      // revokes admission synchronously when its privacy curtain activates.
      if (!isNotificationAccountAvailable(client)) return;
      await refreshNotificationReads(client);
      if (!active.current || !allowed.current) return;
      reportDone(
        id ? "Notification marked as read." : "Notifications marked as read.",
      );
    } catch (error) {
      if (!isNotificationAccountAvailable(client)) return;
      if (error instanceof ApiError && error.status === 404)
        await resetNotificationPages(client);
      else if (notificationReadRefused(error)) refuseNotificationReads(client);
      if (!active.current || !allowed.current) return;
      reportError(
        id
          ? "This notification could not be marked as read. Try again."
          : "Notifications could not be marked as read. Try again.",
      );
    } finally {
      endNotificationCommand(client);
    }
  }
  return {
    pending,
    markOne: (id: string) => run(id),
    markAll: () => run(null),
  };
}

type DateFormat =
  { state: "ready"; region: WorkspaceRegion } | { state: "pending" | "error" };

function NotificationTime({
  value,
  format,
}: {
  value: string;
  format: DateFormat;
}) {
  return (
    <time dateTime={value}>
      {format.state === "ready"
        ? formatWorkspaceDateTime(value, format.region, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : format.state === "error"
          ? "Date unavailable"
          : "…"}
    </time>
  );
}

function NotificationItem({
  item,
  compact,
  onNavigate,
  commands,
  format,
}: {
  item: Notification;
  compact: boolean;
  onNavigate?: () => void;
  commands: ReturnType<typeof useNotificationCommands>;
  format: DateFormat;
}) {
  const suspended = useWorkspaceInteractionSuspended();
  const source = useQuery({
    ...notificationTitleOptions(item),
    enabled: !suspended,
  });
  const title =
    !source.isFetching && !source.isError ? source.data?.title : undefined;
  const refused =
    source.error instanceof ApiError &&
    [401, 403, 404].includes(source.error.status);
  let label: string, href: string | null, actionLabel: string;
  switch (item.kind) {
    case "report-run":
      label = "Scheduled report run";
      href = `/openview?section=reports&report=${item.reportId}&run=${item.runId}`;
      actionLabel = "Open report";
      break;
    case "report-run-failed":
      label = "Report run failed";
      href = `/openview?section=reports&report=${item.reportId}`;
      actionLabel = "Open report";
      break;
    case "post-publish":
      label = "Board post";
      href = `/boards?board=${item.boardId}&section=posts&post=${item.postId}`;
      actionLabel = "Open post";
      break;
    case "event-reminder":
      label = "Event reminder";
      href = `/boards?board=${item.boardId}&section=calendar&event=${item.eventId}`;
      actionLabel = "Open event";
      break;
    case "backup-failed":
      label = "Backup failed";
      href = "/manage?view=backup";
      actionLabel = "Open backup history";
      break;
    case "record-assigned":
      label = "Record assignment";
      href = `/openview?section=views&module=${item.moduleId}&record=${item.subjectId}`;
      actionLabel = "Open record";
      break;
    case "invitation-accepted":
      label = "Invitation accepted";
      href = `/access?view=people&user=${item.subjectId}`;
      actionLabel = "Open person";
      break;
    case "sandbox-published":
      label = "Sandbox publication";
      href = "/sandbox?section=history";
      actionLabel = "Open version history";
      break;
    case "access-changed":
      label = "Access changed";
      href = null;
      actionLabel = "";
      break;
  }
  const timeLabel =
    item.kind === "post-publish"
      ? "Publication time"
      : item.kind === "event-reminder"
        ? "Reminder due"
        : "Scheduled";
  const unread = item.status === "unread";
  return (
    <li
      className={
        compact ? "space-y-2 py-3" : "space-y-2 py-4 first:pt-0 last:pb-0"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-2 size-2 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}`}
          />
          <div className="min-w-0">
            {title ? (
              <p
                className={`break-words ${unread ? "font-semibold" : "font-medium"}`}
              >
                {title}
              </p>
            ) : refused ? (
              <p className="text-muted-foreground text-sm">
                You no longer have access to this item.
              </p>
            ) : source.isError ? (
              <Alert role="alert" variant="destructive">
                The title couldn’t be loaded.
              </Alert>
            ) : (
              <p className="text-muted-foreground text-sm">Checking title…</p>
            )}
            {title !== label && (
              <p className="text-muted-foreground text-sm">{label}</p>
            )}
          </div>
        </div>
        <span
          className={`shrink-0 text-sm ${unread ? "text-foreground font-medium" : "text-muted-foreground"}`}
        >
          {unread ? "Unread" : "Read"}
        </span>
      </div>
      <p className="text-muted-foreground pl-4 text-xs">
        Delivered <NotificationTime value={item.createdAt} format={format} />
        {!compact && item.scheduledFor !== null && (
          <>
            {" "}
            · {timeLabel}{" "}
            <NotificationTime value={item.scheduledFor} format={format} />
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-4">
        {title && href && (
          <GuardedWorkspaceLink
            href={href as Route}
            onAcceptedNavigate={onNavigate}
            className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {actionLabel}
          </GuardedWorkspaceLink>
        )}
        {source.isError && !refused && (
          <Action
            type="button"
            size="sm"
            disabled={source.isFetching}
            onClick={() => void source.refetch()}
          >
            Try again
          </Action>
        )}
        {item.status === "unread" && (
          <Action
            type="button"
            size="sm"
            disabled={Boolean(commands.pending)}
            onClick={() => void commands.markOne(item.id)}
          >
            {commands.pending === item.id ? "Marking as read…" : "Mark as read"}
          </Action>
        )}
      </div>
    </li>
  );
}

export function NotificationItems({
  items,
  compact = false,
  onNavigate,
  commands,
}: {
  items: Notification[];
  compact?: boolean;
  onNavigate?: () => void;
  commands: ReturnType<typeof useNotificationCommands>;
}) {
  const suspended = useWorkspaceInteractionSuspended();
  const workspace = useQuery({
    ...manageWorkspaceOptions(),
    enabled: !suspended,
  });
  const displayRegion = useDisplayRegion(workspace.data);
  const format: DateFormat = displayRegion
    ? { state: "ready", region: displayRegion }
    : { state: workspace.isError ? "error" : "pending" };
  return (
    <ul className="divide-y" aria-label="Notifications">
      {items.map((item) => (
        <NotificationItem
          key={item.id}
          item={item}
          compact={compact}
          onNavigate={onNavigate}
          commands={commands}
          format={format}
        />
      ))}
    </ul>
  );
}
