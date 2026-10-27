"use client";

import { Temporal } from "@js-temporal/polyfill";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Button } from "@/components/ui/button";
import { DialogFrameFooter } from "@/components/ui/dialog-frame";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { datetimeInputToUtc, datetimeOffsets } from "@/lib/date-time";
import type {
  BoardEvent,
  BoardEventCreateInput,
  BoardEventPatchInput,
  BoardEventReminderTiming,
} from "../adapters/board-events-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { ServerBoardAttachments } from "./server-backed-board-attachments";
import { ServerBoardRecordLinks } from "./server-backed-board-record-links";

type Recurrence = BoardEvent["recurrence"];
/** The author's reminder choices, in the order the form shows them. */
export const REMINDER_TIMINGS: readonly {
  value: BoardEventReminderTiming;
  label: string;
}[] = [
  { value: "1d", label: "1 day before" },
  { value: "15m", label: "15 minutes before" },
  { value: "start", label: "When it starts" },
];

function sameTimings(
  left: readonly BoardEventReminderTiming[],
  right: readonly BoardEventReminderTiming[],
): boolean {
  return (
    left.length === right.length && left.every((item) => right.includes(item))
  );
}

export type BoardEventDraft = {
  boardId: string;
  boardRevision: number;
  eventId: string | null;
  eventRevision: number | null;
  title: string;
  details: string;
  location: string;
  links: BoardEvent["links"];
  originalLinks: BoardEvent["links"] | null;
  allDay: boolean;
  start: string;
  end: string;
  timezoneName: string;
  recurrence: Recurrence;
  repeatUntil: string;
  reminders: BoardEventReminderTiming[];
  originalReminders: BoardEventReminderTiming[] | null;
  startOffset: string;
  endOffset: string;
  originalTimezoneName: string | null;
  originalStartAt: string | null;
  originalEndAt: string | null;
};

export class BoardEventDraftError extends Error {}

export type BoardEventLatestVersion = {
  boardId: string;
  boardRevision: number;
  boardActive: boolean;
  event: BoardEvent | null;
};

export function boardEventLinksChanged(draft: BoardEventDraft): boolean {
  if (draft.eventId === null) return false;
  if (draft.originalLinks === null)
    throw new BoardEventDraftError("Reload the event before editing links.");
  return (
    draft.links.length !== draft.originalLinks.length ||
    draft.links.some(
      (link, index) =>
        link.label !== draft.originalLinks?.[index]?.label ||
        link.url !== draft.originalLinks?.[index]?.url,
    )
  );
}

export function prepareBoardEventConflictRetry(
  draft: BoardEventDraft,
  latest: BoardEventLatestVersion,
): BoardEventDraft {
  if (draft.boardId !== latest.boardId || !latest.boardActive)
    throw new BoardEventDraftError(
      "This board is no longer available for event editing.",
    );
  if (draft.eventId === null) {
    if (latest.event !== null)
      throw new BoardEventDraftError(
        "The selected event changed. Reload before retrying.",
      );
    return { ...draft, boardRevision: latest.boardRevision };
  }
  if (
    latest.event === null ||
    latest.event.id !== draft.eventId ||
    latest.event.boardId !== draft.boardId ||
    latest.event.archived
  )
    throw new BoardEventDraftError(
      "The selected event is no longer available for editing.",
    );
  const linksChanged = boardEventLinksChanged(draft);
  const latestLinks = latest.event.links.map((link) => ({ ...link }));
  return {
    ...draft,
    boardRevision: latest.boardRevision,
    eventRevision: latest.event.revision,
    links: linksChanged ? draft.links : latestLinks,
    originalLinks: latestLinks.map((link) => ({ ...link })),
    originalReminders: [...latest.event.reminders],
  };
}

function defaultTimezone(): string {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate });
    return candidate;
  } catch {
    return "Asia/Manila";
  }
}

function localOffset(instant: string, timezone: string): string {
  const local = localDateTime(instant, timezone);
  const offsets = datetimeOffsets(local, timezone);
  if (offsets.length !== 2) return "";
  return (
    offsets.find(
      (offset) =>
        Date.parse(datetimeInputToUtc(local, timezone, offset)) ===
        Date.parse(instant),
    ) ?? ""
  );
}

function localDateTime(instant: string, timezone: string): string {
  try {
    const local = Temporal.Instant.from(instant)
      .toZonedDateTimeISO(timezone)
      .toPlainDateTime();
    return local.toString({
      smallestUnit:
        local.second ||
        local.millisecond ||
        local.microsecond ||
        local.nanosecond
          ? "millisecond"
          : "minute",
    });
  } catch {
    return "";
  }
}

export function newBoardEventDraft(
  boardId: string,
  boardRevision: number,
  date: string,
): BoardEventDraft {
  return {
    boardId,
    boardRevision,
    eventId: null,
    eventRevision: null,
    title: "",
    details: "",
    location: "",
    links: [],
    originalLinks: null,
    allDay: true,
    start: date,
    end: date,
    timezoneName: defaultTimezone(),
    recurrence: "none",
    repeatUntil: "",
    reminders: [],
    originalReminders: null,
    startOffset: "",
    endOffset: "",
    originalTimezoneName: null,
    originalStartAt: null,
    originalEndAt: null,
  };
}

export function boardEventDraftFromEvent(event: BoardEvent): BoardEventDraft {
  const start = event.allDay
    ? (event.startDate ?? "")
    : localDateTime(event.startAt ?? "", event.timezoneName);
  const end = event.allDay
    ? (event.endDate ?? "")
    : localDateTime(event.endAt ?? "", event.timezoneName);
  return {
    boardId: event.boardId,
    boardRevision: event.boardRevision,
    eventId: event.id,
    eventRevision: event.revision,
    title: event.title,
    details: event.details,
    location: event.location,
    links: event.links.map((link) => ({ ...link })),
    originalLinks: event.links.map((link) => ({ ...link })),
    allDay: event.allDay,
    start,
    end,
    timezoneName: event.timezoneName,
    recurrence: event.recurrence,
    repeatUntil: event.repeatUntil ?? "",
    reminders: [...event.reminders],
    originalReminders: [...event.reminders],
    startOffset:
      event.startAt === null
        ? ""
        : localOffset(event.startAt, event.timezoneName),
    endOffset:
      event.endAt === null ? "" : localOffset(event.endAt, event.timezoneName),
    originalTimezoneName: event.timezoneName,
    originalStartAt: event.startAt,
    originalEndAt: event.endAt,
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function boardEventInputFromDraft(
  draft: BoardEventDraft,
): BoardEventCreateInput | BoardEventPatchInput {
  const title = draft.title.trim();
  if (!title || title.length > 100)
    throw new BoardEventDraftError(
      "Enter an event title of up to 100 characters.",
    );
  if (draft.details.trim().length > 4000 || draft.location.trim().length > 240)
    throw new BoardEventDraftError("Shorten the event details or location.");
  if (draft.links.length > 20)
    throw new BoardEventDraftError("Use no more than 20 external links.");
  const links = draft.links.map((link) => {
    const label = link.label.trim();
    const value = link.url.trim();
    if (!label || label.length > 100)
      throw new BoardEventDraftError(
        "Enter a link label of up to 100 characters.",
      );
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BoardEventDraftError("Enter a valid HTTP or HTTPS link URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 2048
    )
      throw new BoardEventDraftError("Enter a valid HTTP or HTTPS link URL.");
    return { label, url: url.href };
  });
  try {
    new Intl.DateTimeFormat("en", { timeZone: draft.timezoneName });
  } catch {
    throw new BoardEventDraftError(
      "Enter a valid IANA timezone, such as Asia/Manila.",
    );
  }
  let startAt: string | undefined;
  let endAt: string | undefined;
  if (draft.allDay) {
    if (
      !validDate(draft.start) ||
      !validDate(draft.end) ||
      draft.end < draft.start
    )
      throw new BoardEventDraftError("Choose ordered start and end dates.");
  } else {
    try {
      startAt =
        draft.originalStartAt &&
        draft.originalTimezoneName === draft.timezoneName &&
        localDateTime(draft.originalStartAt, draft.timezoneName) === draft.start
          ? draft.originalStartAt
          : datetimeInputToUtc(
              draft.start,
              draft.timezoneName,
              draft.startOffset || undefined,
            );
      endAt =
        draft.originalEndAt &&
        draft.originalTimezoneName === draft.timezoneName &&
        localDateTime(draft.originalEndAt, draft.timezoneName) === draft.end
          ? draft.originalEndAt
          : datetimeInputToUtc(
              draft.end,
              draft.timezoneName,
              draft.endOffset || undefined,
            );
    } catch (error) {
      throw new BoardEventDraftError(
        error instanceof Error ? error.message : "Choose valid event times.",
      );
    }
    if (Date.parse(endAt) <= Date.parse(startAt))
      throw new BoardEventDraftError(
        "The end time must be after the start time.",
      );
  }
  const repeatUntil = draft.recurrence === "none" ? null : draft.repeatUntil;
  if (
    draft.recurrence !== "none" &&
    (!validDate(draft.repeatUntil) ||
      draft.repeatUntil < draft.start.slice(0, 10))
  )
    throw new BoardEventDraftError(
      "Choose a repeat-until date on or after the start date.",
    );
  const fields = {
    title,
    details: draft.details.trim(),
    location: draft.location.trim(),
    ...(draft.eventId === null || boardEventLinksChanged(draft)
      ? { links }
      : {}),
    timezoneName: draft.timezoneName,
    recurrence: draft.recurrence,
    repeatUntil,
    ...((draft.originalReminders === null ||
      !sameTimings(draft.reminders, draft.originalReminders)) && {
      reminders: REMINDER_TIMINGS.map((item) => item.value).filter((value) =>
        draft.reminders.includes(value),
      ),
    }),
  };
  if (draft.eventId !== null && draft.eventRevision !== null) {
    return {
      boardRevision: draft.boardRevision,
      eventRevision: draft.eventRevision,
      ...fields,
      allDay: draft.allDay,
      startDate: draft.allDay ? draft.start : null,
      endDate: draft.allDay ? draft.end : null,
      startAt: draft.allDay ? null : startAt,
      endAt: draft.allDay ? null : endAt,
    };
  }
  if (draft.allDay)
    return {
      boardRevision: draft.boardRevision,
      ...fields,
      allDay: true,
      startDate: draft.start,
      endDate: draft.end,
    };
  if (!startAt || !endAt)
    throw new BoardEventDraftError("Choose valid event times.");
  return {
    boardRevision: draft.boardRevision,
    ...fields,
    allDay: false,
    startAt,
    endAt,
  };
}

/**
 * The event editor's body in the shared dialog frame (BR21): Title, When
 * (All day, Starts, Ends, the zone as a suffix), Repeats with Until only
 * while repeating, Location, Details, Reminders with one consequence line,
 * then Files and Linked records once the event is saved, and Advanced last
 * (Time zone, External links, and the clock-change offsets when they apply).
 */
export function ServerBoardEventEditorForm({
  draft,
  busy,
  saveBlocked = false,
  error,
  onChange,
  onCancel,
  onSave,
  onAttachmentBusyChange,
  onRecordLinkBusyChange,
  refreshAttachmentVersions,
  leading,
}: {
  draft: BoardEventDraft;
  busy: boolean;
  saveBlocked?: boolean;
  /** A field before the title: My calendar's Board (BR35). */
  leading?: React.ReactNode;
  error: string | null;
  onChange: (patch: Partial<BoardEventDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
  onAttachmentBusyChange: (busy: boolean) => void;
  onRecordLinkBusyChange: (busy: boolean) => void;
  refreshAttachmentVersions: () => Promise<BoardAttachmentVersions>;
}) {
  const startOffsets = draft.allDay
    ? []
    : datetimeOffsets(draft.start, draft.timezoneName);
  const endOffsets = draft.allDay
    ? []
    : datetimeOffsets(draft.end, draft.timezoneName);
  const offsetsNeeded = startOffsets.length > 1 || endOffsets.length > 1;
  const saved = draft.eventId !== null && draft.eventRevision !== null;
  const zone = (
    <span className="text-muted-foreground shrink-0 text-xs">
      {draft.timezoneName.replaceAll("_", " ")}
    </span>
  );
  return (
    <form
      aria-label={draft.eventId ? "Edit event" : "Create event"}
      className="flex min-w-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <FieldGroup className="gap-4">
        {leading}
        <Field className="gap-1.5">
          <FieldLabel htmlFor="live-board-event-title">Event title</FieldLabel>
          <Input
            id="live-board-event-title"
            required
            maxLength={100}
            disabled={busy}
            value={draft.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>
        <FieldSet className="gap-2">
          <FieldLegend className="text-sm font-medium">When</FieldLegend>
          <label className="flex min-h-11 items-center gap-3 text-sm xl:min-h-8">
            <Checkbox
              checked={draft.allDay}
              disabled={busy}
              onCheckedChange={(checked: boolean) => {
                onChange({
                  allDay: checked,
                  start: checked
                    ? draft.start.slice(0, 10)
                    : `${draft.start.slice(0, 10)}T09:00`,
                  end: checked
                    ? draft.end.slice(0, 10)
                    : `${draft.end.slice(0, 10)}T10:00`,
                  startOffset: "",
                  endOffset: "",
                });
              }}
            />
            All day
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="live-board-event-start">
                {draft.allDay ? "Start date" : "Starts"}
              </FieldLabel>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  id="live-board-event-start"
                  type={draft.allDay ? "date" : "datetime-local"}
                  step={draft.allDay ? undefined : "any"}
                  required
                  disabled={busy}
                  value={draft.start}
                  onChange={(event) =>
                    onChange({ start: event.target.value, startOffset: "" })
                  }
                />
                {draft.allDay ? null : zone}
              </div>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="live-board-event-end">
                {draft.allDay ? "End date" : "Ends"}
              </FieldLabel>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  id="live-board-event-end"
                  type={draft.allDay ? "date" : "datetime-local"}
                  step={draft.allDay ? undefined : "any"}
                  required
                  disabled={busy}
                  value={draft.end}
                  onChange={(event) =>
                    onChange({ end: event.target.value, endOffset: "" })
                  }
                />
                {draft.allDay ? null : zone}
              </div>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="live-board-event-repeat">Repeats</FieldLabel>
              <NativeSelect
                id="live-board-event-repeat"
                className="w-full"
                disabled={busy}
                value={draft.recurrence}
                onChange={(event) =>
                  onChange({
                    recurrence: event.target.value as Recurrence,
                    repeatUntil:
                      event.target.value === "none" ? "" : draft.repeatUntil,
                  })
                }
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </NativeSelect>
            </Field>
            {draft.recurrence !== "none" && (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="live-board-event-until">
                  Repeat until
                </FieldLabel>
                <Input
                  id="live-board-event-until"
                  type="date"
                  required
                  disabled={busy}
                  value={draft.repeatUntil}
                  onChange={(event) =>
                    onChange({ repeatUntil: event.target.value })
                  }
                />
              </Field>
            )}
          </div>
        </FieldSet>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="live-board-event-location">Location</FieldLabel>
          <Input
            id="live-board-event-location"
            maxLength={240}
            disabled={busy}
            value={draft.location}
            onChange={(event) => onChange({ location: event.target.value })}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="live-board-event-details">Details</FieldLabel>
          <Textarea
            id="live-board-event-details"
            maxLength={4000}
            disabled={busy}
            value={draft.details}
            onChange={(event) => onChange({ details: event.target.value })}
          />
        </Field>
        <FieldSet className="gap-1">
          <FieldLegend className="text-sm font-medium">Reminders</FieldLegend>
          <div className="flex flex-wrap gap-x-4">
            {REMINDER_TIMINGS.map((timing) => {
              const id = `live-board-event-reminder-${timing.value}`;
              return (
                <Field
                  key={timing.value}
                  className="min-h-11 w-auto flex-row items-center gap-2 xl:min-h-8"
                >
                  <Checkbox
                    id={id}
                    disabled={busy}
                    checked={draft.reminders.includes(timing.value)}
                    onCheckedChange={(checked) =>
                      onChange({
                        reminders:
                          checked === true
                            ? [...draft.reminders, timing.value]
                            : draft.reminders.filter(
                                (value) => value !== timing.value,
                              ),
                      })
                    }
                  />
                  <FieldLabel htmlFor={id} className="font-normal">
                    {timing.label}
                  </FieldLabel>
                </Field>
              );
            })}
          </div>
          <p className="text-muted-foreground text-sm">
            Everyone who reads this board gets reminders, up to 15 minutes late.
          </p>
        </FieldSet>
      </FieldGroup>
      {saved ? (
        <div className="flex flex-col gap-4">
          <ServerBoardAttachments
            key={`event-attachments:${draft.eventId}`}
            target={{
              kind: "event",
              boardId: draft.boardId,
              contentId: draft.eventId!,
            }}
            {...(saveBlocked
              ? { access: "read" as const }
              : {
                  access: "edit" as const,
                  versions: {
                    boardRevision: draft.boardRevision,
                    contentRevision: draft.eventRevision!,
                  },
                  refreshVersions: refreshAttachmentVersions,
                  onBusyChange: onAttachmentBusyChange,
                })}
          />
          <ServerBoardRecordLinks
            key={`event-record-links:${draft.eventId}`}
            target={{
              kind: "event",
              boardId: draft.boardId,
              contentId: draft.eventId!,
            }}
            {...(saveBlocked
              ? { access: "read" as const }
              : {
                  access: "edit" as const,
                  versions: {
                    boardRevision: draft.boardRevision,
                    contentRevision: draft.eventRevision!,
                  },
                  refreshVersions: refreshAttachmentVersions,
                  onBusyChange: onRecordLinkBusyChange,
                })}
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Files and linked records are added after the event is created.
        </p>
      )}
      <AdvancedSection
        storageKey="boards-event-editor"
        setCount={(draft.links.length ? 1 : 0) + (offsetsNeeded ? 1 : 0)}
        forceOpen={offsetsNeeded}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="live-board-event-timezone">
              Event timezone
            </FieldLabel>
            <Input
              id="live-board-event-timezone"
              required
              maxLength={80}
              disabled={busy}
              value={draft.timezoneName}
              onChange={(event) =>
                onChange({
                  timezoneName: event.target.value,
                  startOffset: "",
                  endOffset: "",
                })
              }
            />
            <FieldDescription>
              An IANA time zone, such as Asia/Manila.
            </FieldDescription>
          </Field>
          {!draft.allDay && offsetsNeeded && (
            <div className="grid gap-3 sm:grid-cols-2">
              {startOffsets.length > 1 && (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="live-board-event-start-offset">
                    Start UTC offset
                  </FieldLabel>
                  <NativeSelect
                    id="live-board-event-start-offset"
                    className="w-full"
                    required
                    disabled={busy}
                    value={draft.startOffset}
                    onChange={(event) =>
                      onChange({ startOffset: event.target.value })
                    }
                  >
                    <option value="">Choose offset</option>
                    {startOffsets.map((offset) => (
                      <option key={offset} value={offset}>
                        {offset}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              {endOffsets.length > 1 && (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="live-board-event-end-offset">
                    End UTC offset
                  </FieldLabel>
                  <NativeSelect
                    id="live-board-event-end-offset"
                    className="w-full"
                    required
                    disabled={busy}
                    value={draft.endOffset}
                    onChange={(event) =>
                      onChange({ endOffset: event.target.value })
                    }
                  >
                    <option value="">Choose offset</option>
                    {endOffsets.map((offset) => (
                      <option key={offset} value={offset}>
                        {offset}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
            </div>
          )}
          <Field className="gap-1.5">
            <FieldLabel>External links</FieldLabel>
            <FieldDescription>
              Up to 20 HTTP or HTTPS links. They open outside OpenSlate.
            </FieldDescription>
            <div className="flex flex-col gap-3">
              {draft.links.map((link, index) => (
                <div
                  key={index}
                  className="grid min-w-0 gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <Field className="gap-1.5">
                    <FieldLabel
                      htmlFor={`live-board-event-link-label-${index}`}
                    >
                      Link label
                    </FieldLabel>
                    <Input
                      id={`live-board-event-link-label-${index}`}
                      maxLength={100}
                      required
                      disabled={busy}
                      value={link.label}
                      onChange={(event) =>
                        onChange({
                          links: draft.links.map((current, position) =>
                            position === index
                              ? { ...current, label: event.target.value }
                              : current,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor={`live-board-event-link-url-${index}`}>
                      Link URL
                    </FieldLabel>
                    <Input
                      id={`live-board-event-link-url-${index}`}
                      type="url"
                      maxLength={2048}
                      required
                      disabled={busy}
                      value={link.url}
                      onChange={(event) =>
                        onChange({
                          links: draft.links.map((current, position) =>
                            position === index
                              ? { ...current, url: event.target.value }
                              : current,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-end xl:min-h-8"
                    disabled={busy}
                    onClick={() =>
                      onChange({
                        links: draft.links.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    Remove link
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start xl:min-h-8"
                disabled={busy || draft.links.length >= 20}
                onClick={() =>
                  onChange({ links: [...draft.links, { label: "", url: "" }] })
                }
              >
                Add link
              </Button>
            </div>
          </Field>
        </div>
      </AdvancedSection>
      <DialogFrameFooter>
        {error ? (
          <p role="alert" className="text-danger-text text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="min-h-11 xl:min-h-8"
            disabled={busy || saveBlocked}
          >
            {busy ? "Saving…" : draft.eventId ? "Save event" : "Create event"}
          </Button>
        </div>
      </DialogFrameFooter>
    </form>
  );
}
