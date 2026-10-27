"use client";

import { useEffect, useRef, useState } from "react";
import {
  useDisplayRegion,
  useDisplayWeekStart,
} from "@/components/use-display-region";
import { formatWorkspaceDate } from "@/lib/date-time";
import type { WorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import {
  parseCalendarView,
  shiftAnchor,
  viewWindow,
  weekDays,
} from "../domain/calendar-dates";
import { dayLabel } from "../components/board-calendar-chips";
import { useCalendarPhone, useCalendarRail } from "./use-calendar-media";

/**
 * The period a calendar shows (BR51): its view, the day it is anchored on,
 * the selected day, the window it reads, and the title. A board's Calendar
 * tab and My calendar each own one; neither knows the other's data.
 */
export function useCalendarPeriod({
  workspaceCalendar,
  requestedView,
}: {
  workspaceCalendar: WorkspaceCalendarSettings | undefined;
  requestedView: string | null;
}) {
  const today = workspaceCalendar?.today ?? null;
  const displayRegion = useDisplayRegion(workspaceCalendar);
  const weekStart = useDisplayWeekStart(
    workspaceCalendar?.week_start ?? "monday",
  );
  const region = displayRegion ?? workspaceCalendar;
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // The period title takes focus after a jump moves the period.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const todayRef = useRef<HTMLButtonElement>(null);
  const [titleFocus, setTitleFocus] = useState(0);
  const phone = useCalendarPhone();
  const wide = useCalendarRail();
  const view = parseCalendarView(requestedView, phone);
  const currentAnchor = anchor ?? today;
  const window =
    currentAnchor && today
      ? viewWindow(view, currentAnchor, weekStart, today)
      : null;

  useEffect(() => {
    if (!today) return;
    setAnchor((current) => current ?? today);
  }, [today]);

  useEffect(() => {
    if (titleFocus > 0) titleRef.current?.focus();
  }, [titleFocus]);

  const anchorDate = currentAnchor ?? "";
  const monthName =
    region && anchorDate
      ? formatWorkspaceDate(`${anchorDate.slice(0, 7)}-01`, region, {
          month: "long",
        })
      : "";
  const days =
    anchorDate && view === "week" ? weekDays(anchorDate, weekStart) : [];
  const title =
    !region || !anchorDate
      ? "Calendar"
      : view === "month"
        ? formatWorkspaceDate(`${anchorDate.slice(0, 7)}-01`, region, {
            month: phone ? "short" : "long",
            year: "numeric",
          })
        : view === "week"
          ? `${formatWorkspaceDate(days[0], region, { month: "short", day: "numeric" })} – ${formatWorkspaceDate(days[6], region, { month: "short", day: "numeric" })}${phone ? "" : `, ${days[6].slice(0, 4)}`}`
          : today
            ? `From ${dayLabel(today, region)}`
            : "Upcoming";
  const daySelected =
    selectedDay &&
    (view !== "month" || selectedDay.slice(0, 7) === anchorDate.slice(0, 7))
      ? selectedDay
      : today && today.slice(0, 7) === anchorDate.slice(0, 7)
        ? today
        : view === "week"
          ? (days[0] ?? anchorDate)
          : `${anchorDate.slice(0, 7)}-01`;

  // The now line moves: Week re-renders on each minute while it shows today.
  const showsToday = view === "week" && today !== null && days.includes(today);
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    if (!showsToday) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => setMinuteTick((value) => value + 1);
    const timeout = setTimeout(
      () => {
        tick();
        interval = setInterval(tick, 60_000);
      },
      60_000 - (Date.now() % 60_000),
    );
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [showsToday]);

  return {
    view,
    phone,
    wide,
    today,
    region,
    displayRegion,
    weekStart,
    window,
    /** The anchored day, or "" before the Workspace date loads. */
    anchorDate,
    monthName,
    days,
    title,
    selectedDay,
    daySelected,
    /** The day a new event starts on. */
    newEventDate: selectedDay ?? currentAnchor ?? window?.start ?? "",
    titleRef,
    todayRef,
    setSelectedDay,
    /** Previous or next period. */
    move(amount: number) {
      if (!anchorDate) return;
      const next = shiftAnchor(view, anchorDate, amount);
      setAnchor(next);
      setSelectedDay(view === "week" ? next : null);
    },
    /** A day picked in the mini month or Today. */
    pick(date: string) {
      setAnchor(date);
      setSelectedDay(date);
    },
    /** A jump that moves the period and focuses its title. */
    jump(date: string) {
      setAnchor(date);
      setSelectedDay(date);
      setTitleFocus((value) => value + 1);
    },
  };
}

export type CalendarPeriod = ReturnType<typeof useCalendarPeriod>;
