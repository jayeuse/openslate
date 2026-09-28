"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  listOpenViewReportNotifications,
  markOpenViewReportNotificationRead,
  type OpenViewReportNotification,
} from "@/components/systems/openview/adapters/report-notification-api";
import { subscribeOpenViewInvalidations } from "@/components/systems/openview/adapters/invalidation-events";
import type { OpenViewPage } from "@/components/systems/openview/adapters/views-api";
import { Action, Panel } from "../../shared/components/ui";

const PAGE_LIMIT = 25;
type NotificationPage = OpenViewPage<OpenViewReportNotification>;

function isAuthorizationDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

function formatUtc(value: string): string {
  return `${new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))} UTC`;
}

function notificationTitle(item: OpenViewReportNotification): string {
  switch (item.kind) {
    case "report-run":
      return "Scheduled report run";
    case "post-publish":
      return "Board post";
    case "event-reminder":
      return "Event reminder";
  }
}

function notificationTimeLabel(item: OpenViewReportNotification): string {
  switch (item.kind) {
    case "report-run":
      return "Scheduled";
    case "post-publish":
      return "Publication time";
    case "event-reminder":
      return "Reminder due";
  }
}

export default function ConnectedReportNotifications() {
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [pendingReadId, setPendingReadId] = useState<string | null>(null);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const currentOffset = useRef(0);
  const currentPage = useRef<NotificationPage | null>(null);
  const pendingRead = useRef(false);

  const loadPage = useCallback(async (offset: number) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listOpenViewReportNotifications({
        limit: PAGE_LIMIT,
        offset,
      });
      if (!mounted.current || sequence !== requestSequence.current) return;
      currentPage.current = result;
      setPage(result);
      currentOffset.current = result.pagination.offset;
      setDenied(false);
    } catch (caught) {
      if (!mounted.current || sequence !== requestSequence.current) return;
      if (isAuthorizationDenied(caught)) {
        currentPage.current = null;
        setPage(null);
        setDenied(true);
        setError(
          "Connected notifications are unavailable. Sign in or ask for access, then retry.",
        );
      } else {
        setError(
          currentPage.current === null
            ? "Connected notifications could not be loaded. Try again."
            : "Could not refresh connected notifications. Showing the last loaded page.",
        );
      }
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadPage(0);
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    if (denied) return;
    return subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync" || event.entity === "in_app_notifications")
        void loadPage(currentOffset.current);
    });
  }, [denied, loadPage]);

  async function markRead(notificationId: string) {
    if (pendingRead.current) return;
    pendingRead.current = true;
    setPendingReadId(notificationId);
    setError(null);
    try {
      await markOpenViewReportNotificationRead(notificationId);
      if (!mounted.current) return;
      await loadPage(currentOffset.current);
    } catch (caught) {
      if (!mounted.current) return;
      if (caught instanceof ApiError && caught.status === 404) {
        requestSequence.current += 1;
        currentPage.current = null;
        currentOffset.current = 0;
        setPage(null);
        await loadPage(0);
      } else if (isAuthorizationDenied(caught)) {
        requestSequence.current += 1;
        currentPage.current = null;
        setPage(null);
        setDenied(true);
        setLoading(false);
        setError(
          "Connected notifications are unavailable. Sign in or ask for access, then retry.",
        );
      } else {
        setError("This notification could not be marked as read. Try again.");
      }
    } finally {
      pendingRead.current = false;
      if (mounted.current) setPendingReadId(null);
    }
  }

  const pagination = page?.pagination;
  return (
    <section aria-label="Connected notifications" aria-busy={loading}>
      <Panel title="Connected notifications">
        <p className="text-muted-foreground text-sm">
          Delivery notices show references and times, not private content or
          exports. Open a Board to see content you can currently access.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">
            {pagination
              ? `${pagination.total} notification${pagination.total === 1 ? "" : "s"}`
              : "Current account"}
          </p>
          <Action
            type="button"
            size="sm"
            disabled={loading || pendingReadId !== null}
            onClick={() => {
              void loadPage(currentOffset.current);
            }}
          >
            Refresh
          </Action>
        </div>
        {loading && !page && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading connected notifications…
          </p>
        )}
        {loading && page && (
          <p role="status" className="text-muted-foreground text-sm">
            Refreshing connected notifications…
          </p>
        )}
        {error && (
          <p
            role={page ? "status" : "alert"}
            className="text-destructive text-sm"
          >
            {error}
          </p>
        )}
        {page && page.items.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No connected notifications on this page.
          </p>
        )}
        {page && page.items.length > 0 && (
          <ul className="divide-y" aria-label="Connected delivery notices">
            {page.items.map((item) => (
              <li key={item.id} className="space-y-2 py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{notificationTitle(item)}</p>
                  <span className="text-muted-foreground text-sm">
                    {item.status === "unread" ? "Unread" : "Read"}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">
                  Delivered{" "}
                  <time dateTime={item.createdAt}>
                    {formatUtc(item.createdAt)}
                  </time>
                  {" · "}
                  {notificationTimeLabel(item)}{" "}
                  <time dateTime={item.scheduledFor}>
                    {formatUtc(item.scheduledFor)}
                  </time>
                </p>
                {item.kind !== "report-run" && (
                  <a
                    className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    href={`/boards?board=${encodeURIComponent(item.boardId)}&section=${item.kind === "post-publish" ? "posts" : "calendar"}`}
                  >
                    {item.kind === "post-publish"
                      ? "Open Board posts"
                      : "Open Board calendar"}
                  </a>
                )}
                {item.status === "unread" && (
                  <Action
                    type="button"
                    size="sm"
                    disabled={pendingReadId !== null}
                    onClick={() => void markRead(item.id)}
                  >
                    {pendingReadId === item.id
                      ? "Marking as read…"
                      : "Mark as read"}
                  </Action>
                )}
              </li>
            ))}
          </ul>
        )}
        {pagination && pagination.total > PAGE_LIMIT && (
          <nav
            aria-label="Connected notification pages"
            className="flex items-center justify-between gap-2"
          >
            <Action
              type="button"
              size="sm"
              disabled={
                loading || pendingReadId !== null || pagination.offset === 0
              }
              onClick={() =>
                void loadPage(Math.max(0, pagination.offset - PAGE_LIMIT))
              }
            >
              Previous
            </Action>
            <span className="text-muted-foreground text-sm">
              {pagination.offset + 1}–{pagination.offset + pagination.count} of{" "}
              {pagination.total}
            </span>
            <Action
              type="button"
              size="sm"
              disabled={
                loading || pendingReadId !== null || !pagination.hasMore
              }
              onClick={() => void loadPage(pagination.offset + PAGE_LIMIT)}
            >
              Next
            </Action>
          </nav>
        )}
      </Panel>
    </section>
  );
}
