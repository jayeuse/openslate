/**
 * Timezone choices for a searchable select (Manage › Organization and
 * Account settings): every IANA zone the browser lists, plus UTC, labelled
 * with its offset at one reference instant. Choosing a zone saves its
 * original IANA identifier; the offset only describes this visit.
 */
export type TimezoneOption = { value: string; label: string };

/** IANA names use underscores for spaces; show them as people write them. */
export function readableTimezone(timezone: string): string {
  return timezone.replaceAll("_", " ");
}

export function timezoneOption(
  timezone: string,
  reference: Date,
): TimezoneOption {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(reference)
    .find((part) => part.type === "timeZoneName")?.value;
  return {
    value: timezone,
    label: `${offset === "GMT" ? "UTC+00:00" : offset?.replace("GMT", "UTC")} · ${readableTimezone(timezone)}`,
  };
}

/** Every listed zone once, sorted, with `saved` kept when the browser omits it. */
export function timezoneCatalog(
  reference: Date,
  saved?: string | null,
): TimezoneOption[] {
  const zones = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  const options = [...zones]
    .sort()
    .map((timezone) => timezoneOption(timezone, reference));
  if (saved && !zones.has(saved))
    options.push(timezoneOption(saved, reference));
  return options;
}
