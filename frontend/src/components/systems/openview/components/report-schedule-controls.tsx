"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  createOpenViewReportSchedule,
  getOpenViewReportScheduleConflict,
  updateOpenViewReportSchedule,
  type OpenViewReportSchedule,
} from "../adapters/report-schedule-api";
import { reportKeys } from "../adapters/report-queries";
import { WEEKDAYS, ordinal } from "../domain/report-words";

export type ReportScheduleDraft = {
  enabled: boolean;
  cadence: "daily" | "weekly" | "monthly";
  timezoneName: string;
  localTime: string;
  weekday: number;
  monthDay: string;
};

class ReportScheduleDraftError extends Error {}

function canonicalIanaTimezone(value: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9._+/-]*$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

export function defaultReportScheduleDraft(
  browserTimezone: string,
): ReportScheduleDraft {
  return {
    enabled: false,
    cadence: "daily",
    timezoneName: canonicalIanaTimezone(browserTimezone) ?? "UTC",
    localTime: "09:00",
    weekday: 0,
    monthDay: "1",
  };
}

export function reportScheduleDraftFrom(
  schedule: OpenViewReportSchedule,
): ReportScheduleDraft {
  return {
    enabled: schedule.enabled,
    cadence: schedule.cadence,
    timezoneName: schedule.timezoneName,
    localTime: schedule.localTime,
    weekday: schedule.weekday ?? 0,
    monthDay: String(schedule.monthDay ?? 1),
  };
}

export function reportSchedulePolicyFrom(draft: ReportScheduleDraft) {
  const timezoneName = canonicalIanaTimezone(draft.timezoneName.trim());
  if (!timezoneName)
    throw new ReportScheduleDraftError("Enter a valid IANA timezone");
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.localTime))
    throw new ReportScheduleDraftError("Choose a valid local time");
  if (
    draft.cadence === "weekly" &&
    (!Number.isInteger(draft.weekday) || draft.weekday < 0 || draft.weekday > 6)
  )
    throw new ReportScheduleDraftError("Choose a weekday");
  const monthDay = Number(draft.monthDay);
  if (
    draft.cadence === "monthly" &&
    (!draft.monthDay.trim() ||
      !Number.isInteger(monthDay) ||
      monthDay < 1 ||
      monthDay > 31)
  )
    throw new ReportScheduleDraftError("Choose a day from 1 to 31");
  return {
    enabled: draft.enabled,
    cadence: draft.cadence,
    timezoneName,
    localTime: draft.localTime,
    weekday: draft.cadence === "weekly" ? draft.weekday : null,
    monthDay: draft.cadence === "monthly" ? monthDay : null,
  };
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function policySignature(draft: ReportScheduleDraft): string {
  try {
    return JSON.stringify(reportSchedulePolicyFrom(draft));
  } catch {
    return JSON.stringify(draft);
  }
}

/** Every IANA zone the browser knows, with the chosen one kept in the list. */
function timezoneChoices(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

type Repeat = "off" | ReportScheduleDraft["cadence"];

/** One label-left row (DESIGN "Slim controls"); phones stack the label. */
function ScheduleRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1.5 md:min-h-10 md:grid-cols-[8rem_minmax(0,1fr)] md:items-center md:gap-3">
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          data-slot="field-label"
          className="text-muted-foreground text-xs font-medium"
        >
          {label}
        </label>
      ) : (
        <span
          data-slot="field-label"
          className="text-muted-foreground text-xs font-medium"
        >
          {label}
        </span>
      )}
      <div className="min-w-0 md:max-w-sm">{children}</div>
    </div>
  );
}

type ReportScheduleControlsProps = {
  reportId: string;
  /** The schedule as read (null: none yet); the caller owns the read. */
  schedule: OpenViewReportSchedule | null;
  region: WorkspaceRegion | undefined;
};

/**
 * Step 2's Change (DC4): the report's schedule as label-left rows (Repeat,
 * Day, Time, Time zone), the next copy, and a quiet Save schedule that waits
 * for a change. Only a manager of the report's module opens it.
 */
export function ReportScheduleControls({
  reportId,
  schedule,
  region,
}: ReportScheduleControlsProps) {
  const queryClient = useQueryClient();
  const baseline = schedule
    ? reportScheduleDraftFrom(schedule)
    : defaultReportScheduleDraft(browserTimezone());
  // The draft belongs to the schedule revision it started from; a newer read
  // (a save here, or someone else's) starts it again.
  const baselineKey = schedule ? `${schedule.id}:${schedule.revision}` : "new";
  const [edit, setEdit] = useState<{
    key: string;
    draft: ReportScheduleDraft;
  } | null>(null);
  const draft = edit?.key === baselineKey ? edit.draft : baseline;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const changed = policySignature(draft) !== policySignature(baseline);
  const id = (part: string) => `report-schedule-${part}-${reportId}`;

  function updateDraft(change: Partial<ReportScheduleDraft>): void {
    setEdit({ key: baselineKey, draft: { ...draft, ...change } });
    setNotice("");
    if (!stale) setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!changed || stale || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const policy = reportSchedulePolicyFrom(draft);
      const saved = schedule
        ? await updateOpenViewReportSchedule({
            reportId,
            revision: schedule.revision,
            ...policy,
          })
        : await createOpenViewReportSchedule({ reportId, ...policy });
      queryClient.setQueryData(reportKeys.schedule(reportId), saved);
      setEdit(null);
      setStale(false);
      setNotice(saved.enabled ? "Schedule saved." : "Schedule turned off.");
    } catch (reason) {
      const conflict = getOpenViewReportScheduleConflict(reason);
      const missing = reason instanceof ApiError && reason.status === 404;
      setStale(
        Boolean(
          conflict &&
          ["schedule_exists", "schedule_conflict", "stale_revision"].includes(
            conflict.code,
          ),
        ) || missing,
      );
      setError(
        reason instanceof ReportScheduleDraftError
          ? reason.message
          : conflict?.code === "schedule_ineligible"
            ? "This module is closed, so the schedule can only be off."
            : (conflict?.message ??
              (missing
                ? "The schedule changed. Reload it before saving."
                : "The schedule could not be saved. Try again.")),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function reload(): void {
    if (savingRef.current) return;
    setEdit(null);
    setStale(false);
    setError("");
    void queryClient.invalidateQueries({
      queryKey: reportKeys.schedule(reportId),
    });
  }

  const repeat: Repeat = draft.enabled ? draft.cadence : "off";
  const nextCopy =
    schedule?.nextDueAt && region
      ? formatWorkspaceDateTime(schedule.nextDueAt, region, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  const lastRun = schedule?.lastRun;
  return (
    <form
      aria-label="Schedule"
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => void save(event)}
    >
      <ScheduleRow label="Repeat">
        <ToggleGroup
          aria-label="Repeat"
          variant="segmented"
          multiple={false}
          disabled={saving}
          value={[repeat]}
          className="w-full md:w-fit"
          onValueChange={(selection) => {
            const next = selection[0] as Repeat | undefined;
            if (!next) return;
            updateDraft(
              next === "off"
                ? { enabled: false }
                : { enabled: true, cadence: next },
            );
          }}
        >
          {(["off", "daily", "weekly", "monthly"] as const).map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="px-3 text-sm whitespace-nowrap"
            >
              {value === "off"
                ? "Off"
                : value.charAt(0).toUpperCase() + value.slice(1)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ScheduleRow>
      {draft.enabled && draft.cadence === "weekly" ? (
        <ScheduleRow label="Day" htmlFor={id("weekday")}>
          <Select
            id={id("weekday")}
            className="min-h-11"
            value={String(draft.weekday)}
            disabled={saving}
            onValueChange={(value) => updateDraft({ weekday: Number(value) })}
          >
            {WEEKDAYS.map((day, index) => (
              <SelectItem key={day} value={String(index)}>
                {day}
              </SelectItem>
            ))}
          </Select>
        </ScheduleRow>
      ) : null}
      {draft.enabled && draft.cadence === "monthly" ? (
        <ScheduleRow label="Day" htmlFor={id("month-day")}>
          <Select
            id={id("month-day")}
            className="min-h-11"
            value={draft.monthDay}
            disabled={saving}
            onValueChange={(value) => updateDraft({ monthDay: value })}
          >
            {Array.from({ length: 31 }, (_, index) => (
              <SelectItem key={index + 1} value={String(index + 1)}>
                {ordinal(index + 1)}
              </SelectItem>
            ))}
          </Select>
        </ScheduleRow>
      ) : null}
      {draft.enabled ? (
        <>
          <ScheduleRow label="Time" htmlFor={id("time")}>
            <Input
              id={id("time")}
              className="min-h-11"
              type="time"
              value={draft.localTime}
              disabled={saving}
              onChange={(event) =>
                updateDraft({ localTime: event.target.value })
              }
            />
          </ScheduleRow>
          <ScheduleRow label="Time zone" htmlFor={id("timezone")}>
            <Select
              id={id("timezone")}
              className="min-h-11"
              value={draft.timezoneName}
              disabled={saving}
              onValueChange={(value) => updateDraft({ timezoneName: value })}
            >
              {timezoneChoices(draft.timezoneName).map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </Select>
          </ScheduleRow>
        </>
      ) : null}
      {schedule?.enabled ? (
        <ScheduleRow label="Next copy">
          <p className="text-sm tabular-nums">
            {schedule.nextDueAt ? (
              <time dateTime={schedule.nextDueAt}>
                {nextCopy ?? "Date unavailable"}
              </time>
            ) : (
              "Not set"
            )}
          </p>
        </ScheduleRow>
      ) : null}
      {lastRun ? (
        <ScheduleRow label="Last run">
          <p role="status" aria-label="Last scheduled run" className="text-sm">
            {lastRun.state.charAt(0).toUpperCase() + lastRun.state.slice(1)}
            {" · "}
            {lastRun.finishedAt ? (
              <time dateTime={lastRun.finishedAt}>
                {region
                  ? formatWorkspaceDateTime(lastRun.finishedAt, region, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "Date unavailable"}
              </time>
            ) : (
              "Finish time not recorded"
            )}
            {lastRun.failureLabel ? <> · {lastRun.failureLabel}</> : null}
          </p>
        </ScheduleRow>
      ) : null}
      {error ? (
        <Alert role="alert" variant="destructive">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 md:pl-[8.75rem]">
        <Button
          type="submit"
          variant="outline"
          className="min-h-11"
          disabled={!changed || stale || saving}
        >
          {saving ? "Saving schedule…" : "Save schedule"}
        </Button>
        {stale ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={saving}
            onClick={reload}
          >
            Reload schedule
          </Button>
        ) : (
          <span role="status" className="text-muted-foreground text-sm">
            {notice || (changed ? "" : "No changes to save")}
          </span>
        )}
      </div>
    </form>
  );
}
