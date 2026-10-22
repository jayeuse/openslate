import { useState } from "react";
import { ToolAdvanced } from "./tool-advanced";
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
import type { Person } from "../../shared/data/sample-people";
import type { Channel, Message } from "../domain/view-model";
import type { Report, Tombstone, Settings } from "../contract/types";

export function ModerationFields({
  channels,
  people,
  messages,
  reports,
  removed,
  settings,
  moderationChannel,
  setModerationChannel,
  restrictedId,
  setRestrictedId,
  restrictionHours,
  setRestrictionHours,
  updateModeration,
  resolveReport,
  removeReportedMessage,
  restoreMessage,
  pending,
}: {
  channels: Channel[];
  people: Person[];
  messages: Message[];
  reports: Report[];
  removed: Tombstone[];
  settings?: Settings;
  moderationChannel: string;
  setModerationChannel: (id: string) => void;
  restrictedId: string;
  setRestrictedId: (id: string) => void;
  restrictionHours: number;
  setRestrictionHours: (hours: number) => void;
  updateModeration: (
    action: "restrict" | "clear" | "lock" | "slow",
    seconds?: number,
  ) => void;
  resolveReport: (id: string) => void;
  removeReportedMessage: (report: Report) => void;
  restoreMessage: (message: Tombstone) => void;
  pending: boolean;
}) {
  const [slow, setSlow] = useState<number | null>(null);
  const controls = (
    <FieldSet
      disabled={pending}
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <FieldLegend className="px-1">Channel moderation</FieldLegend>
      <Field>
        <FieldLabel htmlFor="tools-moderation-channel">
          Moderation channel
        </FieldLabel>
        <NativeSelect
          id="tools-moderation-channel"
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
        <FieldLabel htmlFor="tools-restricted-person">
          Restrict person
        </FieldLabel>
        <NativeSelect
          id="tools-restricted-person"
          className="w-full [&_select]:min-h-11"
          value={restrictedId}
          onChange={(event) => setRestrictedId(event.target.value)}
        >
          <NativeSelectOption value="">Select a person</NativeSelectOption>
          {people.map((person) => (
            <NativeSelectOption key={person.id} value={person.id}>
              {person.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="tools-restriction-hours">
          Restriction hours
        </FieldLabel>
        <Input
          id="tools-restriction-hours"
          type="number"
          min={1}
          max={8760}
          value={restrictionHours}
          onChange={(event) => setRestrictionHours(Number(event.target.value))}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="tools-slow-mode">Slow mode (seconds)</FieldLabel>
        <Input
          id="tools-slow-mode"
          type="number"
          min={0}
          value={slow ?? settings?.slow_mode_seconds ?? 0}
          onChange={(event) => setSlow(Number(event.target.value))}
        />
      </Field>
      <Button
        variant="outline"
        disabled={!settings}
        onClick={() =>
          updateModeration("slow", slow ?? settings?.slow_mode_seconds ?? 0)
        }
      >
        Save slow mode
      </Button>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => updateModeration("restrict")}>
          Restrict posting
        </Button>
        <Button variant="outline" onClick={() => updateModeration("clear")}>
          Clear restrictions
        </Button>
        <Button
          variant="outline"
          disabled={!settings}
          onClick={() => updateModeration("lock")}
        >
          {settings?.locked ? "Unlock channel" : "Lock channel"}
        </Button>
      </div>
    </FieldSet>
  );
  return (
    <>
      <h3 data-slot="section-title" className="font-medium">
        Message reports
      </h3>
      {!reports.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No reported messages.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {reports.map((report) => (
        <Card key={report.id} role="article" className="w-full">
          <CardHeader>
            <CardTitle>{report.reason}</CardTitle>
            <CardDescription>{report.status}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <blockquote className="text-muted-foreground text-sm">
              {messages.find((message) => message.id === report.message_id)
                ?.text ?? "Message unavailable"}
            </blockquote>
            <Separator />
            {report.status === "open" && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => resolveReport(report.id)}
              >
                Resolve report
              </Button>
            )}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => removeReportedMessage(report)}
            >
              Remove message recoverably
            </Button>
          </CardContent>
        </Card>
      ))}
      <Separator />
      <h3 data-slot="section-title" className="font-medium">
        Recoverable messages
      </h3>
      {!removed.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No removed messages.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {removed.map((message) => (
        <Card key={message.id} className="w-full">
          <CardHeader>
            <CardTitle>
              {people.find((person) => person.id === message.author_id)?.name ??
                "Unavailable person"}
            </CardTitle>
            <CardDescription>
              {new Date(message.created_at).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm break-words">Message removed</p>
            <Separator />
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => restoreMessage(message)}
            >
              Restore message
            </Button>
          </CardContent>
        </Card>
      ))}
      <ToolAdvanced
        tool="moderation"
        count={
          Number(!!settings?.locked) +
          Number((settings?.slow_mode_seconds ?? 0) > 0) +
          Number(!!settings?.restricted_person_ids.length)
        }
      >
        {controls}
      </ToolAdvanced>
    </>
  );
}
