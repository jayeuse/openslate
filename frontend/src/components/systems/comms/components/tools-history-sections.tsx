import type { Dispatch, SetStateAction } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Alert } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  COMMS_PERMISSIONS,
  type CommsHistoryEntry,
  type CommsScopeConfiguration,
  type CommsSettingKey,
} from "../domain/configuration";
import type { Message } from "../domain/model";
import { ChevronDown } from "lucide-react";
import { PERMISSION_LABELS } from "./permission-inspector";
import { SETTINGS_LABELS } from "./settings-fields";

export function MessageHistoryFields({
  history,
  currentMessage,
}: {
  history: Message[];
  currentMessage: Message | undefined;
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
        <Card key={`${message.id}-${index}`} role="article" className="w-full">
          <CardHeader>
            <CardTitle>Version {index + 1}</CardTitle>
            <CardDescription>
              {new Date(message.created).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="break-words whitespace-pre-wrap">{message.text}</p>
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
  onPreview,
}: {
  history: CommsHistoryEntry[];
  names: Record<string, string>;
  onPreview: (entry: CommsHistoryEntry) => void;
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
            <CardTitle>{entry.label}</CardTitle>
            <CardDescription>
              {new Date(entry.created).toLocaleString()} · {entry.scope.kind}
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
                  beforeLocks={entry.beforeLocks}
                  afterLocks={entry.afterLocks}
                  names={names}
                />
              </CollapsibleContent>
            </Collapsible>
            <Separator />
            <Button variant="outline" onClick={() => onPreview(entry)}>
              Preview restoration
            </Button>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

export function RetentionPreviewFields({
  days,
  setDays,
  impacted,
  total,
}: {
  days: number;
  setDays: Dispatch<SetStateAction<number>>;
  impacted: Message[];
  total: number;
}) {
  return (
    <>
      <p className="text-sm">
        Inspect the effect of a retention period. This preview never purges
        content.
      </p>
      <Field>
        <FieldLabel htmlFor="tools-dialog-field-5">
          Retention days (0 keeps everything)
        </FieldLabel>
        <Input
          id="tools-dialog-field-5"
          type="number"
          min={0}
          value={days}
          onChange={(event) => setDays(Math.max(0, Number(event.target.value)))}
        />
      </Field>
      <Alert role="status">
        {impacted.length} of {total} messages would be affected.
      </Alert>
      {impacted.map((message) => (
        <Card key={message.id} className="w-full">
          <CardHeader>
            <CardTitle>{message.author}</CardTitle>
            <CardDescription>
              {new Date(message.created).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p>{message.text}</p>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

export function ConfigurationChanges({
  before,
  after,
  beforeLocks,
  afterLocks,
  names,
}: {
  before: CommsScopeConfiguration;
  after: CommsScopeConfiguration;
  beforeLocks?: CommsHistoryEntry["beforeLocks"];
  afterLocks?: CommsHistoryEntry["afterLocks"];
  names: Record<string, string>;
}) {
  const rows: { id: string; label: string; before: string; after: string }[] =
    [];
  function readable(value: unknown): string {
    if (value === undefined) return "Inherited";
    if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
    if (Array.isArray(value))
      return value.length ? value.map(readable).join(", ") : "None";
    if (value === "") return "Not set";
    if (typeof value === "string")
      return names[value] ?? value.replaceAll("-", " ");
    return String(value);
  }
  for (const key of new Set([
    ...Object.keys(before.settings),
    ...Object.keys(after.settings),
  ]) as Set<CommsSettingKey>) {
    const previous = before.settings[key];
    const next = after.settings[key];
    if (JSON.stringify(previous) !== JSON.stringify(next))
      rows.push({
        id: key,
        label: SETTINGS_LABELS[key],
        before: readable(previous),
        after: readable(next),
      });
  }
  for (const subject of new Set([
    ...Object.keys(before.permissions),
    ...Object.keys(after.permissions),
  ]))
    for (const action of COMMS_PERMISSIONS) {
      const previous = before.permissions[subject]?.[action] ?? "inherit";
      const next = after.permissions[subject]?.[action] ?? "inherit";
      if (previous !== next) {
        const [kind, id] = subject.split(":");
        const name =
          subject === "everyone"
            ? "Everyone"
            : (names[id] ??
              `${kind === "role" ? "Role" : "Person"} no longer available`);
        const label = (value: string) =>
          value === "inherit"
            ? "Inherit"
            : value === "allow"
              ? "Allow"
              : "Deny";
        rows.push({
          id: `${subject}-${action}`,
          label: `${name} · ${PERMISSION_LABELS[action]}`,
          before: label(previous),
          after: label(next),
        });
      }
    }
  if (beforeLocks && afterLocks) {
    for (const key of new Set([
      ...beforeLocks.settings,
      ...afterLocks.settings,
    ]))
      if (
        beforeLocks.settings.includes(key) !== afterLocks.settings.includes(key)
      )
        rows.push({
          id: `lock-setting-${key}`,
          label: `${SETTINGS_LABELS[key]} · workspace lock`,
          before: beforeLocks.settings.includes(key) ? "Locked" : "Unlocked",
          after: afterLocks.settings.includes(key) ? "Locked" : "Unlocked",
        });
    for (const key of new Set([
      ...beforeLocks.permissions,
      ...afterLocks.permissions,
    ]))
      if (
        beforeLocks.permissions.includes(key) !==
        afterLocks.permissions.includes(key)
      )
        rows.push({
          id: `lock-permission-${key}`,
          label: `${PERMISSION_LABELS[key]} · workspace lock`,
          before: beforeLocks.permissions.includes(key) ? "Locked" : "Unlocked",
          after: afterLocks.permissions.includes(key) ? "Locked" : "Unlocked",
        });
  }
  return rows.length ? (
    <dl className="mt-3 flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.id} className="text-sm">
          <dt className="font-medium">{row.label}</dt>
          <dd className="text-muted-foreground break-words">
            {row.before} → {row.after}
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
