"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { ApiError } from "@/lib/api";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { Alert } from "@/components/ui/alert";
import { reportDone, reportError } from "@/lib/feedback";
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

function formatUtc(value: string) {
  return `${new Intl.DateTimeFormat("en", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(value))} UTC`;
}

function NotificationItem({
  item,
  compact,
  onNavigate,
  commands,
}: {
  item: Notification;
  compact: boolean;
  onNavigate?: () => void;
  commands: ReturnType<typeof useNotificationCommands>;
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
      actionLabel = "Open Report output";
      break;
    case "report-run-failed":
      label = "Report run failed";
      href = `/openview?section=reports&report=${item.reportId}`;
      actionLabel = "Open Report";
      break;
    case "post-publish":
      label = "Board post";
      href = `/boards?board=${item.boardId}&section=posts&post=${item.postId}`;
      actionLabel = "Open Board posts";
      break;
    case "event-reminder":
      label = "Event reminder";
      href = `/boards?board=${item.boardId}&section=calendar&event=${item.eventId}`;
      actionLabel = "Open Board calendar";
      break;
    case "backup-failed":
      label = "Backup failed";
      href = "/manage?view=backup";
      actionLabel = "Open Backups";
      break;
    case "record-assigned":
      label = "Record assignment";
      href = `/openview?section=views&module=${item.moduleId}&record=${item.subjectId}`;
      actionLabel = "Open Record";
      break;
    case "invitation-accepted":
      label = "Invitation accepted";
      href = `/access?view=people&user=${item.subjectId}`;
      actionLabel = "Open People";
      break;
    case "sandbox-published":
      label = "Sandbox publication";
      href = "/sandbox?section=history";
      actionLabel = "Open Sandbox history";
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
  return (
    <li
      className={
        compact ? "space-y-2 py-3" : "space-y-2 py-4 first:pt-0 last:pb-0"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title ? (
            <p className="font-medium break-words">{title}</p>
          ) : source.isError ? (
            <Alert role="alert" variant="destructive">
              {refused
                ? "Source is unavailable."
                : "Title is unavailable. Try again."}
            </Alert>
          ) : (
            <p className="text-muted-foreground text-sm">Checking title…</p>
          )}
          {title !== label && (
            <p className="text-muted-foreground text-sm">{label}</p>
          )}
        </div>
        <span className="text-muted-foreground shrink-0 text-sm">
          {item.status === "unread" ? "Unread" : "Read"}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        Delivered{" "}
        <time dateTime={item.createdAt}>{formatUtc(item.createdAt)}</time>
        {!compact && item.scheduledFor !== null && (
          <>
            {" "}
            · {timeLabel}{" "}
            <time dateTime={item.scheduledFor}>
              {formatUtc(item.scheduledFor)}
            </time>
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {title && href && (
          <GuardedWorkspaceLink
            href={href as Route}
            onAcceptedNavigate={onNavigate}
            className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {actionLabel}
          </GuardedWorkspaceLink>
        )}
        {source.isError && (
          <Action
            type="button"
            size="sm"
            disabled={source.isFetching}
            onClick={() => void source.refetch()}
          >
            Retry title
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
  return (
    <ul className="divide-y" aria-label="Connected delivery notices">
      {items.map((item) => (
        <NotificationItem
          key={item.id}
          item={item}
          compact={compact}
          onNavigate={onNavigate}
          commands={commands}
        />
      ))}
    </ul>
  );
}
