"use client";
import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";

import { useCommsConfiguration } from "./configuration-state";
import {
  type CommsAutomationRule,
  resolveCommsPermission,
} from "./configuration";
import { ConfigurationFrame } from "./configuration-frame";
import { useSampleState } from "../sample-state";
import {
  CHANNELS,
  CATEGORIES,
  MESSAGES,
  type Message,
  type Thread,
} from "./model";
import { initialPeople } from "../access/model";
import { INITIAL_RECORDS } from "../sample-data";
import { templateText, toolChannelMessages } from "./tools-helpers";
import { validateCommsMessage } from "./message-policy";

export function AutomationTools({
  opener,
  onClose,
  channelId,
}: {
  opener: HTMLElement | null;
  onClose: () => void;
  channelId?: string;
}) {
  const [config, setConfig] = useCommsConfiguration();
  const [channels] = useSampleState("commsChannels", CHANNELS);
  const [categories] = useSampleState("commsCategories", CATEGORIES);
  const [people] = useSampleState("access-people", initialPeople);
  const [threads] = useSampleState<Thread[]>("commsThreads", []);
  const [records] = useSampleState("records", INITIAL_RECORDS);
  const [messages, setMessages] = useSampleState<Message[]>(
    "commsMessages",
    MESSAGES,
  );
  const [draft, setDraft] = useState<CommsAutomationRule>({
    id: "",
    name: "New rule",
    enabled: true,
    event: "record-change",
    filter: "",
    channelId: channelId ?? channels[0]?.id ?? "",
    template: "{{title}} is now {{status}}. Assigned to {{assignee}}.",
    recipientIds: [],
    delivery: "immediate",
  });
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [example, setExample] = useState(records[0]?.id ?? "");
  const change = (patch: Partial<CommsAutomationRule>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setPreview(false);
  };
  const record = records.find((r) => r.id === example);
  const channel = channels.find((c) => c.id === draft.channelId);
  const viewer = people.find((p) => p.id === "sample-eli");
  const sampleMessage = messages.find(
    (m) => m.conversation === draft.channelId,
  );
  const fields = {
    title: record?.title ?? "",
    status: record?.status ?? "",
    assignee: record?.assignee ?? "",
    recordId: record?.id ?? "",
    channel: channel?.name ?? "",
    message: sampleMessage?.text ?? "",
    event: draft.event,
  };
  const rendered = templateText(draft.template, fields);
  const matches =
    !draft.filter ||
    Object.values(fields)
      .join(" ")
      .toLowerCase()
      .includes(draft.filter.toLowerCase());
  function valid() {
    if (!draft.name.trim() || !draft.template.trim() || !channel) {
      setError("Provide a rule name, destination, and message template.");
      return false;
    }
    if (/\{\{[^}]+\}\}/.test(rendered)) {
      setError("Use the supported template fields shown below.");
      return false;
    }
    setError("");
    return true;
  }
  function save() {
    if (
      !resolveCommsPermission(config, { person: viewer }, "manageWorkspace")
        .allowed
    ) {
      setError("Workspace management access is required.");
      return;
    }
    if (!valid()) return;
    const rule = { ...draft, id: draft.id || crypto.randomUUID() };
    setConfig((c) => ({
      ...c,
      rules: c.rules.some((r) => r.id === rule.id)
        ? c.rules.map((r) => (r.id === rule.id ? rule : r))
        : [...c.rules, rule],
    }));
    setDraft(rule);
    setDirty(false);
    setStatus("Automation rule saved. Runs only when you apply a preview.");
  }
  function apply() {
    if (
      !resolveCommsPermission(config, { person: viewer }, "manageWorkspace")
        .allowed
    ) {
      setError("Workspace management access is required.");
      return;
    }
    if (!valid() || !channel) return;
    if (!matches || !draft.enabled) {
      setError("This event does not match an enabled rule.");
      return;
    }
    const failure = validateCommsMessage({
      config,
      person: viewer,
      channel,
      categories,
      people,
      messages: toolChannelMessages(messages, threads, channel.id),
      text: rendered,
      files: [],
      record,
      kind: "post",
      system: true,
    });
    if (failure) {
      setError(failure);
      return;
    }
    setMessages((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        conversation: channel.id,
        author: "OpenComms",
        authorId: "sample-eli",
        text: rendered,
        created: Date.now(),
        pinned: false,
        ...(record ? { recordId: record.id } : {}),
      },
    ]);
    setPreview(false);
    setStatus(
      "Preview applied as a local system message. No notifications were delivered.",
    );
  }
  return (
    <ConfigurationFrame
      title="Automation"
      description="Build rules, inspect sample events, and explicitly apply a local result. No background execution or external delivery."
      opener={opener}
      onClose={onClose}
      dirty={dirty}
      onSave={save}
      saveLabel="Save rule"
    >
      <FieldGroup className="p-5 sm:p-6">
        {error && (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        )}
        {status && (
          <Alert role="status" variant="success">
            {status}
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="tools-automation-field-1">Saved rule</FieldLabel>
          <NativeSelect
            id="tools-automation-field-1"
            className="w-full [&_select]:min-h-11"
            value={draft.id}
            disabled={dirty}
            onChange={(e) => {
              const rule = config.rules.find((r) => r.id === e.target.value);
              if (rule) {
                setDraft(rule);
                setDirty(false);
                setPreview(false);
              }
            }}
          >
            <NativeSelectOption value="">New rule</NativeSelectOption>
            {config.rules.map((r) => (
              <NativeSelectOption key={r.id} value={r.id}>
                {r.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {dirty && (
          <Button
            variant="outline"
            onClick={() => {
              const saved = config.rules.find((r) => r.id === draft.id);
              if (saved) setDraft(saved);
              else
                setDraft({
                  id: "",
                  name: "New rule",
                  enabled: true,
                  event: "record-change",
                  filter: "",
                  channelId: channelId ?? channels[0]?.id ?? "",
                  template:
                    "{{title}} is now {{status}}. Assigned to {{assignee}}.",
                  recipientIds: [],
                  delivery: "immediate",
                });
              setDirty(false);
              setPreview(false);
            }}
          >
            Discard rule draft
          </Button>
        )}
        <Button
          variant="outline"
          disabled={dirty}
          onClick={() => {
            setDraft({ ...draft, id: "", name: "New rule" });
            setPreview(false);
          }}
        >
          New rule
        </Button>
        <Field>
          <FieldLabel htmlFor="tools-automation-field-2">Rule name</FieldLabel>
          <Input
            id="tools-automation-field-2"
            value={draft.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        </Field>
        <Field className="flex-row items-center gap-2">
          <Checkbox
            id="tools-automation-field-3"
            checked={draft.enabled}
            onCheckedChange={(checked) => change({ enabled: checked })}
          />
          <FieldLabel htmlFor="tools-automation-field-3">Enabled</FieldLabel>
        </Field>
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="tools-automation-field-4">Trigger</FieldLabel>
            <NativeSelect
              id="tools-automation-field-4"
              className="w-full [&_select]:min-h-11"
              value={draft.event}
              onChange={(e) =>
                change({
                  event: e.target.value as CommsAutomationRule["event"],
                })
              }
            >
              {[
                "record-change",
                "assignment",
                "message",
                "thread",
                "schedule",
              ].map((v) => (
                <NativeSelectOption key={v} value={v}>
                  {
                    {
                      "record-change": "Record changed",
                      assignment: "Assignment changed",
                      message: "Message posted",
                      thread: "Thread activity",
                      schedule: "Scheduled time",
                    }[v as CommsAutomationRule["event"]]
                  }
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="tools-automation-field-5">
              Destination channel
            </FieldLabel>
            <NativeSelect
              id="tools-automation-field-5"
              className="w-full [&_select]:min-h-11"
              value={draft.channelId}
              onChange={(e) => change({ channelId: e.target.value })}
            >
              {channels.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  #{c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </FieldGroup>
        <Field>
          <FieldLabel htmlFor="tools-automation-field-6">
            Event contains
          </FieldLabel>
          <Input
            id="tools-automation-field-6"
            value={draft.filter}
            onChange={(e) => change({ filter: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="tools-automation-field-7">
            Message template
          </FieldLabel>
          <Textarea
            id="tools-automation-field-7"
            className="min-h-28"
            value={draft.template}
            onChange={(e) => change({ template: e.target.value })}
          />
        </Field>
        <p className="text-muted-foreground text-xs">
          Template fields:{" "}
          {
            "{{title}}, {{status}}, {{assignee}}, {{recordId}}, {{channel}}, {{message}}, {{event}}"
          }
        </p>
        <div
          className="flex flex-wrap gap-2"
          aria-label="Insert template field"
        >
          {Object.keys(fields).map((key) => (
            <Button
              key={key}
              size="sm"
              variant="outline"
              onClick={() =>
                change({ template: draft.template + ` {{${key}}}` })
              }
            >
              Insert {key}
            </Button>
          ))}
        </div>
        <FieldSet className="flex flex-col gap-2">
          <FieldLegend>Recipients</FieldLegend>
          {people
            .filter((p) => p.active)
            .map((p) => (
              <Field key={p.id} className="flex-row items-center gap-2">
                <Checkbox
                  id={`tools-automation-field-8-${p.id}`}
                  checked={draft.recipientIds.includes(p.id)}
                  onCheckedChange={(checked) =>
                    change({
                      recipientIds: checked
                        ? [...draft.recipientIds, p.id]
                        : draft.recipientIds.filter((id) => id !== p.id),
                    })
                  }
                />
                <FieldLabel htmlFor={`tools-automation-field-8-${p.id}`}>
                  {p.name}
                </FieldLabel>
              </Field>
            ))}
        </FieldSet>
        <Field>
          <FieldLabel htmlFor="tools-automation-field-9">Delivery</FieldLabel>
          <NativeSelect
            id="tools-automation-field-9"
            className="w-full [&_select]:min-h-11"
            value={draft.delivery}
            onChange={(e) =>
              change({ delivery: e.target.value as "immediate" | "digest" })
            }
          >
            <NativeSelectOption value="immediate">Immediate</NativeSelectOption>
            <NativeSelectOption value="digest">Digest</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="tools-automation-field-10">
            Sample record
          </FieldLabel>
          <NativeSelect
            id="tools-automation-field-10"
            className="w-full [&_select]:min-h-11"
            value={example}
            onChange={(e) => {
              setExample(e.target.value);
              setPreview(false);
            }}
          >
            {records.map((r) => (
              <NativeSelectOption key={r.id} value={r.id}>
                {r.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Button
          variant="outline"
          onClick={() => {
            if (valid()) setPreview(true);
          }}
        >
          Preview automation
        </Button>
        {preview && (
          <Card aria-label="Automation preview" className="w-full">
            <CardHeader>
              <CardTitle>
                {matches ? "Matching event" : "Filter does not match"}
              </CardTitle>
              <CardDescription>
                #{channel?.name} · {draft.delivery} ·{" "}
                {draft.recipientIds.length} selected recipients. Delivery is a
                preview only.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="break-words whitespace-pre-wrap">{rendered}</p>
              <Separator />
              <Button onClick={apply} disabled={!matches || !draft.enabled}>
                Apply local preview
              </Button>
            </CardContent>
          </Card>
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
