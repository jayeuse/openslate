import { Temporal } from "@js-temporal/polyfill";

export {
  formatWorkspaceClockTime,
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  isIanaTimezone,
  isSupportedWorkspaceLocale,
  type WorkspaceRegion,
} from "./date-time-display";

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
