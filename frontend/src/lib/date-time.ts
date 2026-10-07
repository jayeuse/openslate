import { Temporal } from "@js-temporal/polyfill";

export type WorkspaceRegion = { timezone: string; locale: string };

export function isSupportedWorkspaceLocale(locale: string): boolean {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0;
  } catch {
    return false;
  }
}

function workspaceLocale(locale: string): string {
  return isSupportedWorkspaceLocale(locale) ? locale : "en-US";
}

export function formatDateTimeLocal(value: unknown, timezone = "UTC"): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return Temporal.Instant.from(value)
      .toZonedDateTimeISO(timezone)
      .toPlainDateTime()
      .toString({ smallestUnit: "minute" });
  } catch {
    return "";
  }
}

export function datetimeOffsets(value: string, timezone: string): string[] {
  try {
    const local = Temporal.PlainDateTime.from(value);
    const early = local.toZonedDateTime(timezone, {
      disambiguation: "earlier",
    });
    const late = local.toZonedDateTime(timezone, { disambiguation: "later" });
    return [
      ...new Set(
        [early, late]
          .filter((instant) => instant.toPlainDateTime().equals(local))
          .map((instant) => instant.offset),
      ),
    ];
  } catch {
    return [];
  }
}

export function datetimeInputToUtc(
  value: string,
  timezone: string,
  offset?: string,
): string {
  const offsets = datetimeOffsets(value, timezone);
  if (!offsets.length)
    throw new Error(
      "This local time does not exist in the workspace timezone.",
    );
  if (offsets.length > 1 && !offset)
    throw new Error("This local time occurs twice. Choose its UTC offset.");
  const selected = offset ?? offsets[0];
  if (!offsets.includes(selected))
    throw new Error("Choose a valid UTC offset for this local time.");
  return Temporal.ZonedDateTime.from(`${value}${selected}[${timezone}]`, {
    offset: "reject",
  })
    .toInstant()
    .toString();
}

export function formatWorkspaceDateTime(
  value: string,
  region: WorkspaceRegion,
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(workspaceLocale(region.locale), {
    ...options,
    timeZone: region.timezone,
  }).format(date);
}

export function formatWorkspaceDate(
  value: string,
  region: WorkspaceRegion,
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
    dateStyle: "medium",
  },
): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(workspaceLocale(region.locale), {
    ...options,
    timeZone: dateOnly ? "UTC" : region.timezone,
  }).format(date);
}

/** A wall-clock "HH:MM" time in the workspace's 12- or 24-hour convention. */
export function formatWorkspaceClockTime(
  value: string,
  region: Pick<WorkspaceRegion, "locale">,
): string {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat(workspaceLocale(region.locale), {
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]))));
}
