import type { Dispatch, SetStateAction } from "react";
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
import {
  type CommsConfiguration,
  type CommsThreadMeta,
  resolveCommsSettings,
} from "../domain/configuration";
import type { Category, Channel, Thread } from "../domain/model";

export function ThreadSettingsFields({
  thread,
  meta,
  setMeta,
  setDirty,
  config,
  channel,
  categories,
}: {
  thread: Thread | undefined;
  meta: CommsThreadMeta;
  setMeta: Dispatch<SetStateAction<CommsThreadMeta>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  config: CommsConfiguration;
  channel: Channel | undefined;
  categories: Category[];
}) {
  return !thread ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Thread no longer exists.</EmptyTitle>
      </EmptyHeader>
    </Empty>
  ) : (
    <>
      <Field>
        <FieldLabel htmlFor="tools-dialog-field-1">Thread name</FieldLabel>
        <Input
          id="tools-dialog-field-1"
          value={meta.name ?? ""}
          onChange={(event) => {
            setMeta({ ...meta, name: event.target.value });
            setDirty(true);
          }}
        />
      </Field>
      {(["locked", "resolved", "archived"] as const).map((key) => (
        <Field key={key} className="flex-row items-center gap-2">
          <Checkbox
            id={`tools-dialog-field-2-${key}`}
            checked={meta[key] ?? false}
            onCheckedChange={(checked) => {
              setMeta({ ...meta, [key]: checked });
              setDirty(true);
            }}
          />
          <FieldLabel htmlFor={`tools-dialog-field-2-${key}`}>
            {key[0].toUpperCase() + key.slice(1)}
          </FieldLabel>
        </Field>
      ))}
      <Field className="flex-row items-center gap-2">
        <Checkbox
          id="tools-dialog-field-3"
          checked={meta.followedBy?.includes("sample-eli") ?? false}
          onCheckedChange={(checked) => {
            setMeta({
              ...meta,
              followedBy: checked
                ? [...new Set([...(meta.followedBy ?? []), "sample-eli"])]
                : (meta.followedBy ?? []).filter((id) => id !== "sample-eli"),
            });
            setDirty(true);
          }}
        />
        <FieldLabel htmlFor="tools-dialog-field-3">Follow thread</FieldLabel>
      </Field>
      <p className="text-muted-foreground text-sm">
        Channel defaults: auto-archive{" "}
        {resolveCommsSettings(config, channel, categories).values
          .autoArchiveDays || "off"}
        ; branches{" "}
        {
          resolveCommsSettings(config, channel, categories).values
            .threadBranches
        }
        .
      </p>
    </>
  );
}

export function MessageReportFields({
  messageText,
  reason,
  setReason,
  setDirty,
}: {
  messageText: string | undefined;
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
        <FieldLabel htmlFor="tools-dialog-field-4">Reason</FieldLabel>
        <Textarea
          id="tools-dialog-field-4"
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

type ScheduledMessage = CommsConfiguration["schedules"][number];

export function OutboxFields({
  config,
  selectedSchedule,
  creatingSchedule,
  setCreatingSchedule,
  setScheduleId,
  text,
  setText,
  sendAt,
  setSendAt,
  dirty,
  setDirty,
  preview,
  setPreview,
  onSendNow,
  onCancelSchedule,
}: {
  config: CommsConfiguration;
  selectedSchedule: ScheduledMessage | undefined;
  creatingSchedule: boolean;
  setCreatingSchedule: Dispatch<SetStateAction<boolean>>;
  setScheduleId: Dispatch<SetStateAction<string>>;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  sendAt: string;
  setSendAt: Dispatch<SetStateAction<string>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  preview: boolean;
  setPreview: Dispatch<SetStateAction<boolean>>;
  onSendNow: () => void;
  onCancelSchedule: (id: string) => void;
}) {
  return (
    <>
      <p className="text-muted-foreground text-sm">
        Scheduled messages are not delivered automatically. Messages send only
        when you choose Send Now.
      </p>
      {!config.schedules.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No scheduled messages.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {config.schedules.map((schedule) => (
        <Card key={schedule.id} className="w-full">
          <CardHeader>
            <CardTitle>Scheduled message</CardTitle>
            <CardDescription>
              {new Date(schedule.sendAt).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="h-auto justify-start text-left whitespace-normal"
              aria-label={`${schedule.text} · ${new Date(schedule.sendAt).toLocaleString()}`}
              onClick={() => {
                setScheduleId(schedule.id);
                setCreatingSchedule(false);
                setText(schedule.text);
                setSendAt(
                  new Date(
                    schedule.sendAt -
                      new Date(schedule.sendAt).getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16),
                );
                setPreview(false);
                setDirty(false);
              }}
            >
              {schedule.text}
            </Button>
          </CardContent>
        </Card>
      ))}
      {(selectedSchedule || creatingSchedule) && (
        <>
          <Field>
            <FieldLabel htmlFor="tools-dialog-field-6">
              Scheduled message
            </FieldLabel>
            <Textarea
              id="tools-dialog-field-6"
              className="min-h-28"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setDirty(true);
                setPreview(false);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tools-dialog-field-7">
              Scheduled time
            </FieldLabel>
            <Input
              id="tools-dialog-field-7"
              type="datetime-local"
              value={sendAt}
              onChange={(event) => {
                setSendAt(event.target.value);
                setDirty(true);
              }}
            />
          </Field>
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
                  {new Date(selectedSchedule.sendAt).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p>{selectedSchedule.text}</p>
                <Separator />
                <Button onClick={onSendNow}>Send Now</Button>
              </CardContent>
            </Card>
          )}
          {selectedSchedule && (
            <Button
              variant="outline"
              onClick={() => onCancelSchedule(selectedSchedule.id)}
            >
              Cancel scheduled message
            </Button>
          )}
        </>
      )}
    </>
  );
}
