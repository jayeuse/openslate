import type { Dispatch, SetStateAction } from "react";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { datetimeOffsets, formatWorkspaceDateTime } from "@/lib/date-time";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ToolAdvanced } from "./tool-advanced";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { ThreadPatch, Settings, Schedule } from "../contract/types";
import type { Thread } from "../domain/view-model";

export type ThreadDraft = ThreadPatch & { followed: boolean };
export function ThreadSettingsFields({
  thread,
  meta,
  setMeta,
  setDirty,
  settings,
}: {
  thread: Thread | undefined;
  meta: ThreadDraft;
  setMeta: Dispatch<SetStateAction<ThreadDraft>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  settings?: Settings;
}) {
  if (!thread)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Thread no longer exists.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  return (
    <>
      <Field>
        <FieldLabel htmlFor="tools-thread-name">Thread name</FieldLabel>
        <Input
          id="tools-thread-name"
          value={meta.name ?? ""}
          onChange={(event) => {
            setMeta({ ...meta, name: event.target.value });
            setDirty(true);
          }}
        />
      </Field>
      {(["locked", "resolved", "archived", "followed"] as const).map((key) => (
        <Field key={key} className="flex-row items-center gap-2">
          <Checkbox
            id={`tools-thread-${key}`}
            checked={meta[key] ?? false}
            onCheckedChange={(checked) => {
              setMeta({ ...meta, [key]: checked });
              setDirty(true);
            }}
          />
          <FieldLabel htmlFor={`tools-thread-${key}`}>
            {key === "followed"
              ? "Follow thread"
              : key[0].toUpperCase() + key.slice(1)}
          </FieldLabel>
        </Field>
      ))}
      {settings && (
        <p className="text-muted-foreground text-sm">
          Channel defaults: auto-archive {settings.auto_archive_days || "off"};
          branches {settings.thread_branches}.
        </p>
      )}
    </>
  );
}
export function MessageReportFields({
  messageText,
  reason,
  setReason,
  setDirty,
}: {
  messageText?: string;
  reason: string;
  setReason: Dispatch<SetStateAction<string>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Reported message</CardTitle>
        </CardHeader>
        <CardContent>
          <blockquote>{messageText ?? "Message unavailable"}</blockquote>
        </CardContent>
      </Card>
      <Field>
        <FieldLabel htmlFor="tools-report-reason">Reason</FieldLabel>
        <Textarea
          id="tools-report-reason"
          className="min-h-28"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setDirty(true);
          }}
        />
      </Field>
    </>
  );
}
export function OutboxFields({
  schedules,
  selectedSchedule,
  creatingSchedule,
  onSelectSchedule,
  text,
  setText,
  sendAt,
  setSendAt,
  timeUnchanged,
  utcOffset,
  setUtcOffset,
  dirty,
  setDirty,
  preview,
  setPreview,
  onSendNow,
  onCancelSchedule,
}: {
  schedules: Schedule[];
  selectedSchedule?: Schedule;
  creatingSchedule: boolean;
  onSelectSchedule: (schedule: Schedule) => void;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  sendAt: string;
  setSendAt: Dispatch<SetStateAction<string>>;
  timeUnchanged: boolean;
  utcOffset: string;
  setUtcOffset: Dispatch<SetStateAction<string>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  preview: boolean;
  setPreview: Dispatch<SetStateAction<boolean>>;
  onSendNow: () => void;
  onCancelSchedule: (id: string) => void;
}) {
  const region = useWorkspaceDisplayRegion();
  const timestamp = (value: string) =>
    region ? formatWorkspaceDateTime(value, region) : value;
  const offsets =
    timeUnchanged || !region ? [] : datetimeOffsets(sendAt, region.timezone);
  return (
    <>
      <p className="text-muted-foreground text-sm">
        In this local example, scheduled messages send when you choose Send Now.
      </p>
      {!schedules.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No scheduled messages.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {schedules.map((schedule) => (
        <Card key={schedule.id} className="w-full">
          <CardHeader>
            <CardTitle>Scheduled message</CardTitle>
            <CardDescription>
              {timestamp(schedule.request.send_at)} · {schedule.status}
              {schedule.failure_code
                ? ` · ${schedule.failure_code.replaceAll("_", " ")}`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="h-auto justify-start text-left whitespace-normal"
              aria-label={`${schedule.request.body} · ${timestamp(schedule.request.send_at)}`}
              disabled={dirty || !region}
              onClick={() => onSelectSchedule(schedule)}
            >
              {schedule.request.body}
            </Button>
          </CardContent>
        </Card>
      ))}
      {(selectedSchedule || creatingSchedule) && (
        <>
          <Field>
            <FieldLabel htmlFor="tools-scheduled-message">
              Scheduled message
            </FieldLabel>
            <Textarea
              id="tools-scheduled-message"
              className="min-h-28"
              value={text}
              disabled={
                !!selectedSchedule && selectedSchedule.status !== "pending"
              }
              onChange={(event) => {
                setText(event.target.value);
                setDirty(true);
                setPreview(false);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tools-scheduled-time">
              Scheduled time
            </FieldLabel>
            <Input
              id="tools-scheduled-time"
              type="datetime-local"
              value={sendAt}
              disabled={
                !!selectedSchedule && selectedSchedule.status !== "pending"
              }
              onChange={(event) => {
                setSendAt(event.target.value);
                setUtcOffset("");
                setDirty(true);
                setPreview(false);
              }}
            />
          </Field>
          {offsets.length > 1 && (
            <Field>
              <FieldLabel htmlFor="tools-scheduled-offset">
                Scheduled UTC offset
              </FieldLabel>
              <NativeSelect
                id="tools-scheduled-offset"
                className="w-full [&_select]:min-h-11"
                required
                value={utcOffset}
                disabled={
                  !!selectedSchedule && selectedSchedule.status !== "pending"
                }
                onChange={(event) => {
                  setUtcOffset(event.target.value);
                  setDirty(true);
                  setPreview(false);
                }}
              >
                <NativeSelectOption value="">Choose offset</NativeSelectOption>
                {offsets.map((offset) => (
                  <NativeSelectOption key={offset} value={offset}>
                    {offset}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Button
            variant="outline"
            disabled={dirty || !selectedSchedule}
            onClick={() => setPreview(true)}
          >
            Preview scheduled message
          </Button>
          {dirty && <Alert>Save your changes before previewing.</Alert>}
          {preview && selectedSchedule && (
            <Card className="w-full">
              <CardHeader>
                <CardTitle>Scheduled message preview</CardTitle>
                <CardDescription>
                  {timestamp(selectedSchedule.request.send_at)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p>{selectedSchedule.request.body}</p>
                <Separator />
                <Button
                  disabled={selectedSchedule.status !== "pending"}
                  onClick={onSendNow}
                >
                  Send Now
                </Button>
              </CardContent>
            </Card>
          )}
          {selectedSchedule && (
            <Button
              variant="outline"
              disabled={selectedSchedule.status !== "pending"}
              onClick={() => onCancelSchedule(selectedSchedule.id)}
            >
              Cancel scheduled message
            </Button>
          )}
        </>
      )}
      <ToolAdvanced tool="outbox">
        <p className="text-muted-foreground text-sm">
          Time zone: {region?.timezone ?? "Loading regional settings…"}.
          Scheduled times use your regional settings.
        </p>
      </ToolAdvanced>
    </>
  );
}
