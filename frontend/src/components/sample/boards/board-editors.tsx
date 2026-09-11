"use client";
import { useState } from "react";
import { initialRoles, departments } from "../access/model";
import { Bell, CalendarDays, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useSampleState } from "@/components/sample/sample-state";
import type { SampleRecord } from "@/components/sample/sample-data";

type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  visibility: string;
  recurrence: string;
  recordId: string;
};
type Announcement = {
  id: string;
  title: string;
  body: string;
  audience: string;
  expires: string;
  pinned: boolean;
};
type Notice = { id: string; title: string; recordId?: string; read: boolean };
const blankEvent: CalendarEvent = {
  id: "",
  title: "",
  date: "",
  visibility: "Organization",
  recurrence: "Never",
  recordId: "",
};
const blankAnnouncement: Announcement = {
  id: "",
  title: "",
  body: "",
  audience: "Everyone",
  expires: "",
  pinned: false,
};
function Choice({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-2 text-sm">
      {label}
      <Select aria-label={label} value={value} onValueChange={onChange}>
        {values.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </Select>
    </label>
  );
}

export function BoardCalendar({ records }: { records: SampleRecord[] }) {
  const [events, setEvents] = useSampleState<CalendarEvent[]>("boards-events", [
    {
      id: "sample-event-briefing",
      title: "Operations weekly briefing",
      date: "2026-09-14",
      visibility: "Organization",
      recurrence: "Weekly",
      recordId: "",
    },
  ]);
  const [draft, setDraft] = useState<CalendarEvent | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [, setNotifications] = useSampleState<Notice[]>(
    "platformNotifications",
    [],
  );
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Team calendar
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Coordinate the next handoff, visit, or milestone.
          </p>
        </div>
        <Button onClick={() => setDraft(blankEvent)}>
          <Plus />
          New event
        </Button>
      </header>
      {draft && (
        <form
          className="bg-card grid gap-4 rounded-xl border p-5 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.title.trim() || !draft.date) return;
            const next = {
              ...draft,
              title: draft.title.trim(),
              id: draft.id || `sample-event-${crypto.randomUUID()}`,
            };
            setEvents(
              draft.id
                ? events.map((item) => (item.id === draft.id ? next : item))
                : [...events, next],
            );
            setDraft(null);
            setMessage("Sample event saved.");
          }}
        >
          <h3 className="font-medium sm:col-span-2">
            {draft.id ? "Edit event" : "New event"}
          </h3>
          <label className="space-y-2 text-sm">
            Event title
            <Input
              required
              maxLength={100}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label className="space-y-2 text-sm">
            Event date
            <Input
              required
              type="date"
              value={draft.date}
              onChange={(event) =>
                setDraft({ ...draft, date: event.target.value })
              }
            />
          </label>
          <Choice
            label="Event visibility"
            value={draft.visibility}
            values={["Organization", "Department", "User"]}
            onChange={(visibility) => setDraft({ ...draft, visibility })}
          />
          <Choice
            label="Recurrence"
            value={draft.recurrence}
            values={["Never", "Daily", "Weekly", "Monthly"]}
            onChange={(recurrence) => setDraft({ ...draft, recurrence })}
          />
          <label className="space-y-2 text-sm sm:col-span-2">
            Linked record
            <Select
              aria-label="Linked record"
              value={draft.recordId}
              onValueChange={(recordId) => setDraft({ ...draft, recordId })}
            >
              <option value="">No linked record</option>
              {records.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.title}
                </option>
              ))}
            </Select>
          </label>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            Recurring dates and visibility are sample settings. Reminders are
            recorded locally when you select Remind.
          </p>
          <div className="flex gap-2 sm:col-span-2">
            <Button>Save event</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="bg-card divide-y rounded-xl border">
        {[...events]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((event) => (
            <article
              key={event.id}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start"
            >
              <div className="flex shrink-0 items-center gap-3 sm:w-32 sm:flex-col sm:items-start">
                <CalendarDays className="text-muted-foreground size-5" />
                <time className="text-sm font-medium" dateTime={event.date}>
                  {event.date}
                </time>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">{event.title}</h3>
                <p className="text-muted-foreground mt-2 text-xs">
                  {event.visibility} ·{" "}
                  {event.recurrence === "Never"
                    ? "One-time event"
                    : `Repeats ${event.recurrence.toLowerCase()}`}
                </p>
                {event.recordId && (
                  <a
                    href={`/openview?record=${encodeURIComponent(event.recordId)}`}
                    className="mt-3 inline-block text-sm underline underline-offset-4"
                  >
                    {records.find((record) => record.id === event.recordId)
                      ?.title ?? "Linked sample request"}
                  </a>
                )}
                {pendingDelete === event.id && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <span className="text-sm">Delete this sample event?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setEvents(
                          events.filter((item) => item.id !== event.id),
                        );
                        setPendingDelete(null);
                        setMessage("Sample event deleted.");
                      }}
                    >
                      Confirm delete event
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remind ${event.title}`}
                  onClick={() => {
                    setNotifications((previous) => [
                      {
                        id: `sample-notification-${crypto.randomUUID()}`,
                        title: `Reminder: ${event.title}`,
                        recordId: event.recordId || undefined,
                        read: false,
                      },
                      ...previous,
                    ]);
                    setMessage(
                      `Sample reminder recorded for ${event.title}. No message was sent.`,
                    );
                  }}
                >
                  <Bell />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${event.title}`}
                  onClick={() => setDraft(event)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${event.title}`}
                  onClick={() => setPendingDelete(event.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </article>
          ))}
        {events.length === 0 && (
          <p className="text-muted-foreground p-12 text-center text-sm">
            No events yet. Create an event to plan what comes next.
          </p>
        )}
      </div>
      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
export function BoardAnnouncements() {
  const [roles] = useSampleState("access-roles", initialRoles);
  const [announcements, setAnnouncements] = useSampleState<Announcement[]>(
    "boards-announcements",
    [
      {
        id: "sample-announcement-welcome",
        title: "A clearer week starts here.",
        body: "Use this board to keep everyone aligned on priorities, upcoming work, and important changes.",
        audience: "Everyone",
        expires: "",
        pinned: true,
      },
    ],
  );
  const [draft, setDraft] = useState<Announcement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Announcements
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            The updates everyone should see.
          </p>
        </div>
        <Button onClick={() => setDraft(blankAnnouncement)}>
          <Plus />
          New announcement
        </Button>
      </header>
      {draft && (
        <form
          className="bg-card grid gap-4 rounded-xl border p-5 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.title.trim() || !draft.body.trim()) return;
            const next = {
              ...draft,
              title: draft.title.trim(),
              body: draft.body.trim(),
              id: draft.id || `sample-announcement-${crypto.randomUUID()}`,
            };
            setAnnouncements(
              draft.id
                ? announcements.map((item) =>
                    item.id === draft.id ? next : item,
                  )
                : [...announcements, next],
            );
            setDraft(null);
            setMessage(
              "Sample announcement saved. No audience notification was sent.",
            );
          }}
        >
          <label className="space-y-2 text-sm sm:col-span-2">
            Announcement title
            <Input
              required
              maxLength={100}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label className="space-y-2 text-sm sm:col-span-2">
            Announcement message
            <textarea
              required
              maxLength={2000}
              rows={4}
              className="bg-background block w-full rounded-lg border p-3"
              value={draft.body}
              onChange={(event) =>
                setDraft({ ...draft, body: event.target.value })
              }
            />
          </label>
          <Choice
            label="Announcement audience"
            value={draft.audience}
            values={[
              "Everyone",
              ...departments.map((department) => `Department: ${department}`),
              ...roles.map((role) => `Role: ${role.name}`),
            ]}
            onChange={(audience) => setDraft({ ...draft, audience })}
          />
          <label className="space-y-2 text-sm">
            Expiration date
            <Input
              type="date"
              value={draft.expires}
              onChange={(event) =>
                setDraft({ ...draft, expires: event.target.value })
              }
            />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(event) =>
                setDraft({ ...draft, pinned: event.target.checked })
              }
            />
            Pin announcement
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button>Save announcement</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="bg-card divide-y rounded-xl border">
        {[...announcements]
          .sort((a, b) => Number(b.pinned) - Number(a.pinned))
          .map((announcement) => (
            <article key={announcement.id} className="p-6">
              <header className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                    {announcement.pinned ? "Pinned / " : ""}
                    {announcement.audience}
                  </p>
                  <h3 className="text-xl font-semibold tracking-tight">
                    {announcement.title}
                  </h3>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${announcement.pinned ? "Unpin" : "Pin"} ${announcement.title}`}
                    onClick={() =>
                      setAnnouncements(
                        announcements.map((item) =>
                          item.id === announcement.id
                            ? { ...item, pinned: !item.pinned }
                            : item,
                        ),
                      )
                    }
                  >
                    <Pin />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${announcement.title}`}
                    onClick={() => setDraft(announcement)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${announcement.title}`}
                    onClick={() => setPendingDelete(announcement.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </header>
              <p className="text-muted-foreground mt-4 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap">
                {announcement.body}
              </p>
              <p className="text-muted-foreground mt-5 text-xs">
                {announcement.expires
                  ? `Expires ${announcement.expires}`
                  : "No expiration"}{" "}
                · Sample announcement
              </p>
              {pendingDelete === announcement.id && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-sm">
                    Delete this sample announcement?
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setAnnouncements(
                        announcements.filter(
                          (item) => item.id !== announcement.id,
                        ),
                      );
                      setPendingDelete(null);
                      setMessage("Sample announcement deleted.");
                    }}
                  >
                    Confirm delete announcement
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(null)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </article>
          ))}
        {announcements.length === 0 && (
          <p className="text-muted-foreground p-12 text-center text-sm">
            All caught up. Create an announcement when there is news to share.
          </p>
        )}
      </div>
      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
