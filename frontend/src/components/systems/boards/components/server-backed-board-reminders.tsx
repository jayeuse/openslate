"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { BoardEventOccurrencePage } from "../adapters/board-events-api";
import {
  cancelBoardReminder,
  listBoardReminders,
  setBoardEventReminder,
  type BoardEventReminder,
  type BoardReminderTiming,
} from "../adapters/board-reminders-api";

type Occurrence = BoardEventOccurrencePage["items"][number];

function reminderError(error: unknown): string {
  if (error instanceof ApiError) {
    if ([401, 403, 404].includes(error.status))
      return "Your access to this Board or event changed. Refresh the Board.";
    if (error.status === 409)
      return "This event or reminder changed. Refresh the calendar and try again.";
  }
  return "Reminders could not be updated. Try again.";
}

function occurrenceLabel(occurrence: Occurrence): string {
  return `${occurrence.event.title} · ${occurrence.date}${occurrence.event.allDay ? " · All day" : ""}`;
}

function reminderLabel(
  reminder: BoardEventReminder,
  occurrences: Occurrence[],
): string {
  const occurrence = occurrences.find(
    (item) =>
      item.id === reminder.occurrenceId && item.eventId === reminder.eventId,
  );
  if (occurrence) return occurrenceLabel(occurrence);
  return `Event occurrence · ${reminder.occurrenceStartAt.slice(0, 10)}`;
}

export function ServerBoardReminders({
  boardId,
  boardActive,
  occurrences,
  refreshKey,
}: {
  boardId: string;
  boardActive: boolean;
  occurrences: Occurrence[];
  refreshKey: number;
}) {
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [items, setItems] = useState<BoardEventReminder[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [timing, setTiming] = useState<BoardReminderTiming>("15m");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const choices = useMemo(
    () => [...new Map(occurrences.map((item) => [item.id, item])).values()],
    [occurrences],
  );
  const selected = choices.find((item) => item.id === selectedId) ?? choices[0];

  useEffect(() => {
    let active = true;
    void listBoardReminders(boardId, offset)
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setHasMore(page.hasMore);
        setTotal(page.total);
        setStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setItems([]);
        setHasMore(false);
        setTotal(0);
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [boardId, offset, refreshKey, reload]);

  async function saveReminder() {
    if (!selected || pending || !boardActive) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await setBoardEventReminder(
        boardId,
        selected.eventId,
        selected.id,
        timing,
      );
      setNotice("Reminder saved for this occurrence.");
      setOffset(0);
      setReload((value) => value + 1);
    } catch (saveError) {
      setError(reminderError(saveError));
    } finally {
      setPending(false);
    }
  }

  async function cancelReminder(reminderId: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await cancelBoardReminder(boardId, reminderId);
      setNotice("Reminder canceled.");
      setOffset(0);
      setReload((value) => value + 1);
    } catch (cancelError) {
      setError(reminderError(cancelError));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label="Your Board reminders"
      className="border-border min-w-0 space-y-4 rounded-xl border p-4"
    >
      <div>
        <h3 data-slot="section-title" className="font-semibold">
          Your reminders
        </h3>
        <p className="text-muted-foreground text-sm">
          Reminders are private and arrive in your OpenSlate inbox.
        </p>
      </div>
      {boardActive && choices.length > 0 && (
        <details className="border-border min-w-0 rounded-md border px-3">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            Add reminder
          </summary>
          <div className="grid min-w-0 gap-3 pb-3">
            <label className="space-y-1 text-sm font-medium">
              <span>Event occurrence</span>
              <select
                aria-label="Event occurrence for reminder"
                className="border-input bg-background min-h-11 w-full min-w-0 rounded-md border px-3"
                value={selected?.id ?? ""}
                disabled={pending}
                onChange={(event) => setSelectedId(event.currentTarget.value)}
              >
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {occurrenceLabel(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span>Notify me</span>
              <select
                aria-label="Reminder timing"
                className="border-input bg-background min-h-11 w-full min-w-0 rounded-md border px-3"
                value={timing}
                disabled={pending}
                onChange={(event) =>
                  setTiming(event.currentTarget.value as BoardReminderTiming)
                }
              >
                <option value="15m">15 minutes before</option>
                <option value="1d">1 day before</option>
                <option value="start">At start</option>
                <option value="now">Now</option>
              </select>
            </label>
            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={pending}
              onClick={() => void saveReminder()}
            >
              Save reminder
            </Button>
          </div>
        </details>
      )}
      {status === "loading" && <p role="status">Loading your reminders…</p>}
      {status === "error" && (
        <Alert variant="warning">
          Your reminders could not be loaded.{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </Button>
        </Alert>
      )}
      {status === "ready" && (
        <>
          {items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No pending reminders on this page.
            </p>
          ) : (
            <ul className="space-y-2" aria-label="Pending reminders">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="border-border flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                >
                  <span className="min-w-0 flex-1 text-sm break-words">
                    {reminderLabel(item, choices)} ·{" "}
                    {item.timing === "15m"
                      ? "15 minutes before"
                      : item.timing === "1d"
                        ? "1 day before"
                        : item.timing === "start"
                          ? "At start"
                          : "Now"}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending}
                    onClick={() => void cancelReminder(item.id)}
                    aria-label={`Cancel reminder for ${reminderLabel(item, choices)}`}
                  >
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{total} pending</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={offset === 0 || pending}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!hasMore || pending}
              onClick={() => setOffset(offset + 25)}
            >
              Next
            </Button>
          </div>
        </>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
