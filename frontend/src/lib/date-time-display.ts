export type WorkspaceRegion = {
  timezone: string;
  locale: string;
  dateFormat?: "organization" | "dmy" | "mdy" | "ymd";
  timeFormat?: "organization" | "12h" | "24h";
};

export function isIanaTimezone(value: string): boolean {
  if (!value || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function displayFormat(
  region: WorkspaceRegion,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let locale = workspaceLocale(region.locale);
  const effective = { ...options };
  if ((effective.timeStyle || effective.hour) && effective.hour12 === undefined)
    effective.hour12 = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
    }).resolvedOptions().hour12;
  // Month/weekday-only labels keep their wording; complete dates use the
  // confirmed personal order. Input conversion never calls this function.
  if (
    region.dateFormat &&
    region.dateFormat !== "organization" &&
    (effective.dateStyle ||
      (effective.year && effective.month && effective.day))
  ) {
    locale = { dmy: "en-GB", mdy: "en-US", ymd: "sv-SE" }[region.dateFormat];
    delete effective.dateStyle;
    if (effective.timeStyle) {
      const style = effective.timeStyle;
      delete effective.timeStyle;
      effective.hour = "numeric";
      effective.minute = "2-digit";
      if (style !== "short") effective.second = "2-digit";
      if (style === "long" || style === "full")
        effective.timeZoneName = style === "full" ? "long" : "short";
    }
    effective.year = "numeric";
    effective.month = "2-digit";
    effective.day = "2-digit";
  }
  if (
    region.timeFormat &&
    region.timeFormat !== "organization" &&
    (effective.timeStyle || effective.hour)
  ) {
    effective.hour12 = region.timeFormat === "12h";
    if (region.timeFormat === "24h") effective.hourCycle = "h23";
  }
  return new Intl.DateTimeFormat(locale, effective);
}

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
  return displayFormat(region, {
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
  return displayFormat(region, {
    ...options,
    timeZone: dateOnly ? "UTC" : region.timezone,
  }).format(date);
}

/** A wall-clock "HH:MM" time in the workspace's 12- or 24-hour convention. */
export function formatWorkspaceClockTime(
  value: string,
  region: Pick<WorkspaceRegion, "locale" | "timeFormat">,
): string {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat(workspaceLocale(region.locale), {
    timeStyle: "short",
    timeZone: "UTC",
    ...(region.timeFormat && region.timeFormat !== "organization"
      ? { hour12: region.timeFormat === "12h" }
      : {}),
  }).format(new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]))));
}
