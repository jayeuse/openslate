"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import {
  createOpenViewReportSchedule,
  getOpenViewReportSchedule,
  getOpenViewReportScheduleConflict,
  updateOpenViewReportSchedule,
  type OpenViewReportSchedule,
} from "../adapters/report-schedule-api";

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

function formatUtc(value: string): string {
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

function scheduleSummary(schedule: OpenViewReportSchedule): string {
  const cadence =
    schedule.cadence === "weekly"
      ? `Weekly on ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][schedule.weekday ?? 0]}`
      : schedule.cadence === "monthly"
        ? `Monthly on day ${schedule.monthDay}`
        : "Daily";
  return `${schedule.enabled ? "" : "Paused · "}${cadence} at ${schedule.localTime} (${schedule.timezoneName})`;
}

function policySignature(draft: ReportScheduleDraft): string {
  try {
    return JSON.stringify(reportSchedulePolicyFrom(draft));
  } catch {
    return JSON.stringify(draft);
  }
}

type ReportScheduleControlsProps = {
  reportId: string;
  /** Only a manager of the Report module changes its schedule. */
  canManage: boolean;
  disabled: boolean;
  disabledReason?: string;
};

export function ReportScheduleControls({
  reportId,
  canManage,
  disabled,
  disabledReason,
}: ReportScheduleControlsProps) {
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "denied" | "failed"
  >("loading");
  const [schedule, setSchedule] = useState<OpenViewReportSchedule | null>(null);
  const [draft, setDraft] = useState<ReportScheduleDraft>(() =>
    defaultReportScheduleDraft("UTC"),
  );
  const [baselineDraft, setBaselineDraft] = useState<ReportScheduleDraft>(() =>
    defaultReportScheduleDraft("UTC"),
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    setError("");
    setNotice("");
    void getOpenViewReportSchedule(reportId)
      .then((loaded) => {
        if (!active) return;
        setSchedule(loaded);
        const loadedDraft = reportScheduleDraftFrom(loaded);
        setDraft(loadedDraft);
        setBaselineDraft(loadedDraft);
        setStale(false);
        setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setSchedule(null);
        if (reason instanceof ApiError && reason.status === 404) {
          const nextDraft = defaultReportScheduleDraft(browserTimezone());
          setDraft(nextDraft);
          setBaselineDraft(nextDraft);
          setStale(false);
          setLoadState("ready");
        } else if (
          reason instanceof ApiError &&
          (reason.status === 401 || reason.status === 403)
        ) {
          const nextDraft = defaultReportScheduleDraft("UTC");
          setDraft(nextDraft);
          setBaselineDraft(nextDraft);
          setStale(false);
          setLoadState("denied");
        } else {
          setLoadState("failed");
        }
      });
    return () => {
      active = false;
    };
  }, [reportId, loadVersion]);

  const changed = policySignature(draft) !== policySignature(baselineDraft);
  const unavailable = !canManage || disabled || saving || loadState !== "ready";

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (unavailable || savingRef.current) return;
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
      setSchedule(saved);
      const savedDraft = reportScheduleDraftFrom(saved);
      setDraft(savedDraft);
      setBaselineDraft(savedDraft);
      setStale(false);
      setNotice(
        saved.enabled
          ? "Schedule saved and enabled."
          : "Schedule saved disabled.",
      );
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        (reason.status === 401 || reason.status === 403)
      ) {
        setSchedule(null);
        const nextDraft = defaultReportScheduleDraft("UTC");
        setDraft(nextDraft);
        setBaselineDraft(nextDraft);
        setLoadState("denied");
      } else {
        const conflict = getOpenViewReportScheduleConflict(reason);
        setStale(
          Boolean(
            conflict &&
            ["schedule_exists", "schedule_conflict", "stale_revision"].includes(
              conflict.code,
            ),
          ) ||
            (reason instanceof ApiError && reason.status === 404),
        );
        setError(
          reason instanceof ReportScheduleDraftError
            ? reason.message
            : conflict?.code === "schedule_ineligible"
              ? "This Report cannot be enabled for scheduling right now because its data source is closed. Save the schedule turned off, or reopen the data source."
              : (conflict?.message ??
                (reason instanceof ApiError && reason.status === 404
                  ? "The Report or schedule changed. Reload the saved schedule before retrying."
                  : "The schedule could not be saved. Your changes remain here; retry or reload.")),
        );
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function reload(): void {
    if (savingRef.current) return;
    if (
      changed &&
      !window.confirm(
        "Replace your unsaved schedule changes with the latest saved policy?",
      )
    )
      return;
    setLoadVersion((version) => version + 1);
  }

  function updateDraft(change: Partial<ReportScheduleDraft>): void {
    setDraft((current) => ({ ...current, ...change }));
    setNotice("");
    if (!stale) setError("");
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Schedule</CardTitle>
        <CardDescription>
          {canManage
            ? "Choose a local time for future runs. The server determines the next due time."
            : "Read the saved schedule and its next run."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loadState === "loading" ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading schedule…
          </p>
        ) : null}
        {loadState === "denied" ? (
          <Alert role="alert" variant="destructive">
            Schedule details are unavailable. Sign in or ask for access, then
            try again.
            <Button
              type="button"
              variant="outline"
              className="ml-3 min-h-11"
              onClick={reload}
            >
              Retry
            </Button>
          </Alert>
        ) : null}
        {loadState === "failed" ? (
          <Alert role="alert" variant="destructive">
            Schedule details could not be loaded. Try again.
            <Button
              type="button"
              variant="outline"
              className="ml-3 min-h-11"
              onClick={reload}
            >
              Retry
            </Button>
          </Alert>
        ) : null}
        {loadState === "ready" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-sm">
                {schedule
                  ? `Saved policy · revision ${schedule.revision}`
                  : "No saved schedule yet"}
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={saving}
                onClick={reload}
              >
                Reload saved schedule
              </Button>
            </div>
            {schedule?.nextDueAt ? (
              <p className="text-sm">
                Next run:{" "}
                <time dateTime={schedule.nextDueAt}>
                  {formatUtc(schedule.nextDueAt)}
                </time>
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                {schedule
                  ? "No next run while this schedule is disabled."
                  : "No next run is scheduled."}
              </p>
            )}
            {!canManage ? (
              <div className="text-muted-foreground space-y-1 text-sm">
                <p>
                  {schedule ? scheduleSummary(schedule) : "No saved schedule."}
                </p>
                <p>Only a manager of this module changes the schedule.</p>
              </div>
            ) : disabledReason ? (
              <p className="text-muted-foreground text-sm">{disabledReason}</p>
            ) : null}
            {canManage ? (
              <form
                onSubmit={(event) => void save(event)}
                className="flex flex-col gap-4"
              >
                <p className="text-muted-foreground text-sm">
                  Scheduled runs use workspace access. People who could read
                  this report’s module when a run was created can open that
                  output while they still have access.
                </p>
                <Field className="min-h-11 flex-row items-center gap-3">
                  <Checkbox
                    id={`report-schedule-enabled-${reportId}`}
                    checked={draft.enabled}
                    disabled={unavailable}
                    onCheckedChange={(value) =>
                      updateDraft({ enabled: value === true })
                    }
                  />
                  <FieldLabel htmlFor={`report-schedule-enabled-${reportId}`}>
                    Enable scheduled runs
                  </FieldLabel>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`report-schedule-cadence-${reportId}`}>
                      Repeat
                    </FieldLabel>
                    <Select
                      id={`report-schedule-cadence-${reportId}`}
                      className="min-h-11"
                      value={draft.cadence}
                      onValueChange={(value) =>
                        updateDraft({
                          cadence: value as ReportScheduleDraft["cadence"],
                        })
                      }
                      disabled={unavailable}
                    >
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`report-schedule-time-${reportId}`}>
                      Local time
                    </FieldLabel>
                    <Input
                      id={`report-schedule-time-${reportId}`}
                      className="min-h-11"
                      type="time"
                      value={draft.localTime}
                      disabled={unavailable}
                      onChange={(event) =>
                        updateDraft({ localTime: event.target.value })
                      }
                    />
                  </Field>
                  {draft.cadence === "weekly" ? (
                    <Field>
                      <FieldLabel
                        htmlFor={`report-schedule-weekday-${reportId}`}
                      >
                        Weekday
                      </FieldLabel>
                      <Select
                        id={`report-schedule-weekday-${reportId}`}
                        className="min-h-11"
                        value={String(draft.weekday)}
                        onValueChange={(value) =>
                          updateDraft({ weekday: Number(value) })
                        }
                        disabled={unavailable}
                      >
                        {[
                          "Monday",
                          "Tuesday",
                          "Wednesday",
                          "Thursday",
                          "Friday",
                          "Saturday",
                          "Sunday",
                        ].map((day, index) => (
                          <SelectItem key={day} value={String(index)}>
                            {day}
                          </SelectItem>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  {draft.cadence === "monthly" ? (
                    <Field>
                      <FieldLabel
                        htmlFor={`report-schedule-month-day-${reportId}`}
                      >
                        Day of month
                      </FieldLabel>
                      <Input
                        id={`report-schedule-month-day-${reportId}`}
                        className="min-h-11"
                        type="number"
                        min={1}
                        max={31}
                        step={1}
                        value={draft.monthDay}
                        disabled={unavailable}
                        onChange={(event) =>
                          updateDraft({ monthDay: event.target.value })
                        }
                      />
                    </Field>
                  ) : null}
                  <Field className="sm:col-span-2">
                    <FieldLabel
                      htmlFor={`report-schedule-timezone-${reportId}`}
                    >
                      Timezone
                    </FieldLabel>
                    <Input
                      id={`report-schedule-timezone-${reportId}`}
                      className="min-h-11"
                      value={draft.timezoneName}
                      disabled={unavailable}
                      onChange={(event) =>
                        updateDraft({ timezoneName: event.target.value })
                      }
                      autoComplete="off"
                    />
                    <FieldDescription>
                      Use an IANA name such as Asia/Manila. Local clocks adjust
                      for daylight saving time where applicable.
                    </FieldDescription>
                  </Field>
                </div>
                {error ? (
                  <Alert role="alert" variant="destructive">
                    {error}
                  </Alert>
                ) : null}
                {notice ? (
                  <p role="status" className="text-sm">
                    {notice}
                  </p>
                ) : null}
                <div className={canManage ? "flex flex-wrap gap-2" : "hidden"}>
                  <Button
                    type="submit"
                    className="min-h-11"
                    disabled={
                      unavailable || stale || (Boolean(schedule) && !changed)
                    }
                  >
                    {saving
                      ? "Saving schedule…"
                      : schedule
                        ? "Save schedule"
                        : "Create schedule"}
                  </Button>
                  {stale ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={saving}
                      onClick={reload}
                    >
                      Reload latest schedule
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
