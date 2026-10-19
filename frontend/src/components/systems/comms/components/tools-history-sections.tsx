import { ChevronDown } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type {
  ConfigurationHistory,
  ConfigurationSnapshot,
  MessageRevision,
  RetentionPreview,
} from "../contract/types";
import type { Message } from "../domain/view-model";

export function MessageHistoryFields({
  history,
  currentMessage,
}: {
  history: MessageRevision[];
  currentMessage?: Message;
}) {
  return (
    <>
      {!history.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No saved edits for this message.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {history.map((message, index) => (
        <Card key={message.id} role="article" className="w-full">
          <CardHeader>
            <CardTitle>Version {index + 1}</CardTitle>
            <CardDescription>
              {new Date(message.created_at).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="break-words whitespace-pre-wrap">{message.body}</p>
          </CardContent>
        </Card>
      ))}
      {currentMessage && (
        <Card role="article" className="w-full">
          <CardHeader>
            <CardTitle>Current message</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="break-words whitespace-pre-wrap">
              {currentMessage.text}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
export function ConfigurationHistoryFields({
  history,
  names,
}: {
  history: ConfigurationHistory[];
  names: Record<string, string>;
}) {
  return (
    <>
      {!history.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No configuration changes yet.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {history.map((entry) => (
        <Card key={entry.id} role="article" className="w-full">
          <CardHeader>
            <CardTitle>Changed {entry.scope.kind} settings</CardTitle>
            <CardDescription>
              {new Date(entry.created_at).toLocaleString()} ·{" "}
              {names[entry.actor_id] ?? "Unavailable person"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Collapsible>
              <CollapsibleTrigger
                render={
                  <Button variant="ghost" className="justify-between px-0" />
                }
              >
                Before and after{" "}
                <ChevronDown data-icon="inline-end" aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ConfigurationChanges
                  before={entry.before}
                  after={entry.after}
                  names={names}
                />
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
export function RetentionPreviewFields({
  days,
  setDays,
  preview,
  onPreview,
  onApply,
  disabled,
  inherited,
}: {
  days: number;
  setDays: (days: number) => void;
  preview?: RetentionPreview;
  onPreview: () => void;
  onApply: () => void;
  disabled: boolean;
  inherited?: boolean;
}) {
  return (
    <>
      <p className="text-sm">
        Inspect the effect of a retention period before saving. Preview never
        purges content.
      </p>
      <Field>
        <FieldLabel htmlFor="tools-retention-days">
          Retention days (0 keeps everything)
        </FieldLabel>
        <Input
          id="tools-retention-days"
          type="number"
          min={0}
          value={days}
          disabled={inherited}
          onChange={(event) => setDays(Number(event.target.value))}
        />
      </Field>
      <Button variant="outline" disabled={disabled} onClick={onPreview}>
        Preview impact
      </Button>
      {preview && (
        <>
          <Alert role="status">
            {preview.message_count} messages and {preview.file_count} files
            would be affected.
          </Alert>
          <Button disabled={disabled} onClick={onApply}>
            Apply retention policy
          </Button>
        </>
      )}
    </>
  );
}
export function ConfigurationChanges({
  before,
  after,
  names,
}: {
  before: ConfigurationSnapshot;
  after: ConfigurationSnapshot;
  names: Record<string, string>;
}) {
  const rows: { key: string; before: unknown; after: unknown }[] = [];
  for (const key of new Set([
    ...Object.keys(before.settings),
    ...Object.keys(after.settings),
  ]) as Set<keyof ConfigurationSnapshot["settings"]>) {
    if (
      JSON.stringify(before.settings[key]) !==
      JSON.stringify(after.settings[key])
    )
      rows.push({
        key,
        before: before.settings[key],
        after: after.settings[key],
      });
  }
  for (const key of [
    "capabilities",
    "setting_locks",
    "capability_locks",
    "dm_rule",
  ] as const)
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      rows.push({ key, before: before[key], after: after[key] });
  function readable(value: unknown): string {
    if (value === undefined) return "Inherited";
    if (typeof value === "string") return names[value] ?? value;
    if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
    if (Array.isArray(value))
      return value.length ? value.map(readable).join(", ") : "None";
    if (value && typeof value === "object")
      return Object.entries(value)
        .map(([key, item]) => `${key.replaceAll("_", " ")}: ${readable(item)}`)
        .join("; ");
    return String(value);
  }
  return rows.length ? (
    <dl className="mt-3 flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.key} className="text-sm">
          <dt className="font-medium">{row.key.replaceAll("_", " ")}</dt>
          <dd className="text-muted-foreground break-words">
            {readable(row.before)} → {readable(row.after)}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No changed overrides or locks.</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
