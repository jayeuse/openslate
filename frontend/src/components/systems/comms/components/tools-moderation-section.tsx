import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Field,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import type { Person } from "../../access/domain/model";
import type {
  CommsConfiguration,
  CommsPermission,
} from "../domain/configuration";
import { resolveCommsSettings } from "../domain/configuration";
import type { Category, Channel, Message, Thread } from "../domain/model";
import { threadMessages } from "../domain/model";

export function ModerationFields({
  config,
  channels,
  categories,
  people,
  messages,
  threads,
  moderationChannel,
  setModerationChannel,
  restrictedId,
  setRestrictedId,
  restrictionHours,
  setRestrictionHours,
  updateModeration,
  allowed,
  resolveReport,
  removeReportedMessage,
  restoreMessage,
}: {
  config: CommsConfiguration;
  channels: Channel[];
  categories: Category[];
  people: Person[];
  messages: Message[];
  threads: Thread[];
  moderationChannel: string;
  setModerationChannel: Dispatch<SetStateAction<string>>;
  restrictedId: string;
  setRestrictedId: Dispatch<SetStateAction<string>>;
  restrictionHours: number;
  setRestrictionHours: Dispatch<SetStateAction<number>>;
  updateModeration: (action: "restrict" | "clear" | "lock") => void;
  allowed: (action: CommsPermission, target?: Channel | undefined) => boolean;
  resolveReport: (id: string) => void;
  removeReportedMessage: (message: Message) => void;
  restoreMessage: (message: Message) => void;
}) {
  return (
    <>
      <FieldSet className="flex flex-col gap-3 rounded-md border p-4">
        <FieldLegend className="px-1">Channel moderation</FieldLegend>
        <Field>
          <FieldLabel htmlFor="tools-dialog-field-8">
            Moderation channel
          </FieldLabel>
          <NativeSelect
            id="tools-dialog-field-8"
            className="w-full [&_select]:min-h-11"
            value={moderationChannel}
            onChange={(event) => setModerationChannel(event.target.value)}
          >
            {channels.map((channel) => (
              <NativeSelectOption key={channel.id} value={channel.id}>
                #{channel.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="tools-dialog-field-9">
            Restrict person
          </FieldLabel>
          <NativeSelect
            id="tools-dialog-field-9"
            className="w-full [&_select]:min-h-11"
            value={restrictedId}
            onChange={(event) => setRestrictedId(event.target.value)}
          >
            <NativeSelectOption value="">Select a person</NativeSelectOption>
            {people
              .filter((person) => person.active)
              .map((person) => (
                <NativeSelectOption key={person.id} value={person.id}>
                  {person.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="tools-dialog-field-10">
            Restriction hours
          </FieldLabel>
          <Input
            id="tools-dialog-field-10"
            type="number"
            min={1}
            max={8760}
            value={restrictionHours}
            onChange={(event) =>
              setRestrictionHours(Number(event.target.value))
            }
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void updateModeration("restrict")}
          >
            Restrict posting
          </Button>
          <Button
            variant="outline"
            onClick={() => void updateModeration("clear")}
          >
            Clear restrictions
          </Button>
          <Button
            variant="outline"
            onClick={() => void updateModeration("lock")}
          >
            {resolveCommsSettings(
              config,
              channels.find((channel) => channel.id === moderationChannel),
              categories,
            ).values.locked
              ? "Unlock channel"
              : "Lock channel"}
          </Button>
        </div>
      </FieldSet>
      <Separator />
      <h3 data-slot="section-title" className="font-medium">
        Message reports
      </h3>
      {!config.reports.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No reported messages.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {config.reports.map((report) => {
        const reportMessage =
          messages.find((message) => message.id === report.messageId) ??
          threads
            .flatMap(threadMessages)
            .find((message) => message.id === report.messageId);
        return (
          <Card key={report.id} role="article" className="w-full">
            <CardHeader>
              <CardTitle>{report.reason}</CardTitle>
              <CardDescription>{report.status}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <blockquote className="text-muted-foreground text-sm">
                {reportMessage?.text ?? "Message removed"}
              </blockquote>
              <Separator />
              {report.status === "open" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!allowed("moderate")) return;
                    void resolveReport(report.id);
                  }}
                >
                  Resolve report
                </Button>
              )}
              {reportMessage && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!allowed("moderate")) return;
                    void removeReportedMessage(reportMessage);
                  }}
                >
                  Remove message recoverably
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
      <Separator />
      <h3 data-slot="section-title" className="font-medium">
        Recoverable messages
      </h3>
      {!Object.keys(config.tombstones).length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No removed messages.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {Object.values(config.tombstones).map((message) => (
        <Card key={message.id} role="article" className="w-full">
          <CardHeader>
            <CardTitle>{message.author}</CardTitle>
            <CardDescription>
              {new Date(message.created).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm break-words">{message.text}</p>
            <Separator />
            <Button
              variant="outline"
              onClick={() => void restoreMessage(message)}
            >
              Restore message
            </Button>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
