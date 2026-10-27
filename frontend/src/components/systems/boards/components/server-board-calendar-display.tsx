import type { BoardEventOccurrencePage } from "../adapters/board-events-api";
import type { BoardEvent } from "../adapters/board-events-api";
import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time";

type Occurrence = BoardEventOccurrencePage["items"][number];

function formatDate(date: string, region: WorkspaceRegion | undefined): string {
  if (!region) return "Date unavailable";
  return formatWorkspaceDate(date, region, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** The time of one occurrence, in its event's zone, with the zone named. */
export function boardOccurrenceTimeLabel(
  item: Pick<Occurrence, "event" | "start" | "end">,
  region: WorkspaceRegion | undefined,
): string {
  if (!region) return "Date unavailable";
  if (item.event.allDay) {
    return item.start === item.end
      ? `All day · ${formatDate(item.start, region)}`
      : `All day · ${formatDate(item.start, region)}–${formatDate(item.end, region)}`;
  }
  try {
    const options = {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    } as const;
    const eventRegion = { ...region, timezone: item.event.timezoneName };
    return `${formatWorkspaceDateTime(item.start, eventRegion, options)}–${formatWorkspaceDateTime(item.end, eventRegion, options)} · ${item.event.timezoneName.replaceAll("_", " ")}`;
  } catch {
    return `${item.start}–${item.end} UTC`;
  }
}

export function boardEventTimeLabel(
  event: BoardEvent,
  region: WorkspaceRegion | undefined,
): string {
  return boardOccurrenceTimeLabel(
    {
      event,
      start: event.startDate ?? event.startAt ?? "",
      end: event.endDate ?? event.endAt ?? "",
    },
    region,
  );
}
