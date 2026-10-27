"use client";

import { useSyncExternalStore } from "react";

/**
 * The calendar's two layout breakpoints (BR52, BR59), shared by a board's
 * Calendar tab and My calendar: phones (below 768px) and the rail (1440px).
 */
const phoneQuery = "(max-width: 47.99rem)";
const railQuery = "(min-width: 90rem)";
function subscribeQuery(media: string) {
  return (notify: () => void) => {
    const query = window.matchMedia(media);
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  };
}
const subscribePhone = subscribeQuery(phoneQuery);
const subscribeRail = subscribeQuery(railQuery);
function useMedia(
  query: string,
  subscribe: (notify: () => void) => () => void,
) {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useCalendarPhone(): boolean {
  return useMedia(phoneQuery, subscribePhone);
}

export function useCalendarRail(): boolean {
  return useMedia(railQuery, subscribeRail);
}

/** The minute of the day now in the zone, for Week's now line. */
export function minuteNow(timezone: string | undefined): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute)
      ? hour * 60 + minute
      : null;
  } catch {
    return null;
  }
}
