"use client";
import { useState } from "react";
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
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ChevronDown } from "lucide-react";
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

import { useCommsConfiguration } from "../state/configuration-state";
import {
  getCommsScope,
  resolveCommsSettings,
  resolveCommsPermission,
  type CommsHistoryEntry,
  type CommsScopeConfiguration,
  type CommsSettingKey,
  COMMS_PERMISSIONS,
  type CommsThreadMeta,
} from "../domain/configuration";
import { ConfigurationFrame } from "./configuration-frame";
import { useSampleState } from "../../shared/runtime/sample-state";
import {
  CHANNELS,
  CATEGORIES,
  MESSAGES,
  type Message,
  type Thread,
  type Direct,
  threadMessages,
} from "../domain/model";
import { initialPeople, initialRoles } from "../../access/domain/model";
import { INITIAL_RECORDS } from "../../shared/data/sample-data";
import {
  recordScopeChange,
  restoreConfigurationEntry,
  toolChannelMessages,
} from "../domain/tools-helpers";
import { SETTINGS_LABELS } from "./settings-fields";
import { PERMISSION_LABELS } from "./permission-inspector";
import { ManagementTools } from "./tools-management";
import { AutomationTools } from "./tools-automation";
import { validateCommsMessage } from "../domain/message-policy";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
  useCommsCommands,
} from "../state/runtime";

export type CommsToolsView =
  | "management"
  | "templates"
  | "automation"
  | "history"
  | "moderation"
  | "outbox"
  | "retention"
  | "thread"
  | "message-history"
  | "report";
export interface CommsToolsDialogProps {
  view: CommsToolsView;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  opener: HTMLElement | null;
  onClose: () => void;
}
export function CommsToolsDialog(props: CommsToolsDialogProps) {
  if (props.view === "management" || props.view === "templates")
    return <ManagementTools {...props} view={props.view} />;
  if (props.view === "automation") return <AutomationTools {...props} />;
  return <LifecycleTools {...props} />;
}
const titles: Record<CommsToolsView, string> = {
  management: "Channel management",
  templates: "Channel templates",
  automation: "Automation",
  history: "Configuration history",
  moderation: "Moderation",
  outbox: "Scheduled outbox",
  retention: "Retention preview",
  thread: "Thread settings",
  "message-history": "Message history",
  report: "Report message",
};
function LifecycleTools({
  view,
  channelId,
  threadId,
  messageId,
  opener,
  onClose,
}: CommsToolsDialogProps) {
  const [config] = useCommsConfiguration();
  const { run } = useCommsCommands();
  const [channels] = useSampleState("commsChannels", CHANNELS);
  const [categories] = useSampleState("commsCategories", CATEGORIES);
  const [directs] = useSampleState<Direct[]>("commsDirects", []);
  const [people] = useSampleState("access-people", initialPeople);
  const [roles] = useSampleState("access-roles", initialRoles);
  const [records] = useSampleState("records", INITIAL_RECORDS);
  const [messages] = useSampleState<Message[]>("commsMessages", MESSAGES);
  const [threads] = useSampleState<Thread[]>("commsThreads", []);
  const thread = threads.find((t) => t.id === threadId);
  const message =
    messages.find((m) => m.id === messageId) ??
    threads.flatMap(threadMessages).find((m) => m.id === messageId) ??
    config.tombstones[messageId ?? ""];
  const sourceThread = threads.find(
    (item) => item.id === message?.conversation,
  );
  const conversationId =
    sourceThread?.conversation ??
    channelId ??
    thread?.conversation ??
    message?.conversation;
  const channel = channels.find((c) => c.id === conversationId);
  const direct = directs.find((item) => item.id === conversationId);
  const viewer = people.find((p) => p.id === "sample-eli");
  const [meta, setMeta] = useState<CommsThreadMeta>(
    config.threadMeta[threadId ?? ""] ?? {
      resolved: thread?.resolved,
      followedBy: thread?.subscribed ? ["sample-eli"] : [],
    },
  );
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [restore, setRestore] = useState<CommsHistoryEntry | null>(null);
  const [previewTime] = useState(() => Date.now());
  const [days, setDays] = useState(
    resolveCommsSettings(config, channel, categories).values.retentionDays,
  );
  const [scheduleId, setScheduleId] = useState("");
  const [moderationChannel, setModerationChannel] = useState(
    channelId ?? channels[0]?.id ?? "",
  );
  const [restrictedId, setRestrictedId] = useState("");
  const [restrictionHours, setRestrictionHours] = useState(24);
  const selectedSchedule = config.schedules.find((s) => s.id === scheduleId);
  const [creatingSchedule, setCreatingSchedule] = useState(
    view === "outbox" && Boolean(message && (channel || direct)),
  );
  const [text, setText] = useState(
    view === "outbox" ? (message?.text ?? "") : "",
  );
  const [sendAt, setSendAt] = useState("");
  const [preview, setPreview] = useState(false);
  const allowed = (
    action: Parameters<typeof resolveCommsPermission>[2],
    target = channel,
  ) =>
    resolveCommsPermission(
      config,
      { person: viewer, channel: target, categories },
      action,
    ).allowed;
  async function save() {
    if (view === "report") {
      if (!reason.trim() || !message) {
        setError("Enter a reason for reporting this message.");
        return;
      }
      if (!allowed("viewChannel")) {
        setError("Channel access is required.");
        return;
      }
      const result = await run(
        `report:${message.id}`,
        (draft) => {
          const current = readCommsConfiguration(draft);
          const currentMessages = draft.read<Message[]>(
            "commsMessages",
            MESSAGES,
          );
          const currentThreads = draft.read<Thread[]>("commsThreads", []);
          const currentMessage =
            currentMessages.find((item) => item.id === message.id) ??
            currentThreads
              .flatMap(threadMessages)
              .find((item) => item.id === message.id);
          if (!currentMessage && !current.tombstones[message.id])
            return draft.reject("This message is no longer available.");
          stageCommsConfiguration(draft, (value) => ({
            ...value,
            reports: [
              ...value.reports,
              {
                id: crypto.randomUUID(),
                messageId: message.id,
                reporterId: "sample-eli",
                reason: reason.trim(),
                created: Date.now(),
                status: "open",
              },
            ],
          }));
          return null;
        },
        [COMMS_CONFIGURATION_KEY, "commsMessages", "commsThreads"],
      ).catch((error: unknown) =>
        messageFromCommsError(error, "The report could not be submitted."),
      );
      if (result) {
        setError(result);
        return;
      }
      onClose();
      return;
    }
    if (view === "thread") {
      if (!thread) return;
      if (!allowed("manageThreads")) {
        setError("Thread management access is required.");
        return;
      }
      const result = await run(
        `thread-settings:${thread.id}`,
        (draft) => {
          const currentThreads = draft.read<Thread[]>("commsThreads", []);
          if (!currentThreads.some((item) => item.id === thread.id))
            return draft.reject("This thread is no longer available.");
          stageCommsConfiguration(draft, (current) => ({
            ...current,
            threadMeta: { ...current.threadMeta, [thread.id]: meta },
          }));
          draft.update<Thread[]>("commsThreads", [], (all) =>
            all.map((item) =>
              item.id === thread.id
                ? {
                    ...item,
                    resolved: meta.resolved ?? item.resolved,
                    subscribed:
                      meta.followedBy?.includes("sample-eli") ??
                      item.subscribed,
                  }
                : item,
            ),
          );
          return null;
        },
        ["commsThreads", COMMS_CONFIGURATION_KEY],
      ).catch((error: unknown) =>
        messageFromCommsError(error, "Thread settings could not be saved."),
      );
      if (result) {
        setError(result);
        return;
      }
      setDirty(false);
      onClose();
      return;
    }
    if (view === "outbox" && (selectedSchedule || creatingSchedule)) {
      const time = Date.parse(sendAt);
      if (!text.trim() || !Number.isFinite(time)) {
        setError("Enter a message and valid scheduled time.");
        return;
      }
      if (selectedSchedule) {
        const result = await run(
          `schedule:update:${selectedSchedule.id}`,
          (draft) => {
            const current = readCommsConfiguration(draft);
            if (
              !current.schedules.some((item) => item.id === selectedSchedule.id)
            )
              return draft.reject("This scheduled message no longer exists.");
            stageCommsConfiguration(draft, (value) => ({
              ...value,
              schedules: value.schedules.map((item) =>
                item.id === selectedSchedule.id
                  ? { ...item, text: text.trim(), sendAt: time }
                  : item,
              ),
            }));
            return null;
          },
          [COMMS_CONFIGURATION_KEY],
        ).catch((error: unknown) =>
          messageFromCommsError(
            error,
            "The scheduled message could not be saved.",
          ),
        );
        if (result) {
          setError(result);
          return;
        }
      } else {
        if (!conversationId || !message || !viewer) return;
        const schedule = {
          id: crypto.randomUUID(),
          channelId: conversationId,
          text: text.trim(),
          sendAt: time,
          authorId: viewer.id,
          ...(message.recordId ? { recordId: message.recordId } : {}),
        };
        const result = await run(
          `schedule:create:${conversationId}`,
          (draft) => {
            stageCommsConfiguration(draft, (value) => ({
              ...value,
              schedules: [...value.schedules, schedule],
            }));
            return null;
          },
          [COMMS_CONFIGURATION_KEY],
        ).catch((error: unknown) =>
          messageFromCommsError(
            error,
            "The scheduled message could not be saved.",
          ),
        );
        if (result) {
          setError(result);
          return;
        }
        setScheduleId(schedule.id);
        setCreatingSchedule(false);
      }
      setError("");
      setDirty(false);
      setStatus("Scheduled message saved. No external message was sent.");
    }
  }
  async function restoreMessage(original: Message) {
    if (
      !allowed(
        "moderate",
        channels.find((c) => c.id === original.conversation),
      )
    ) {
      setError("Moderation access is required.");
      return;
    }
    const result = await run(
      `message:restore:${original.id}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentThreads = draft.read<Thread[]>("commsThreads", []);
        const currentChannels = draft.read("commsChannels", CHANNELS);
        const currentCategories = draft.read("commsCategories", CATEGORIES);
        const currentPeople = draft.read("access-people", initialPeople);
        const targetThread = currentThreads.find(
          (item) => item.id === original.conversation,
        );
        const targetChannel = currentChannels.find(
          (item) =>
            item.id === (targetThread?.conversation ?? original.conversation),
        );
        const currentViewer = currentPeople.find(
          (item) => item.id === "sample-eli" && item.active,
        );
        if (
          !currentViewer ||
          !resolveCommsPermission(
            currentConfig,
            {
              person: currentViewer,
              channel: targetChannel,
              categories: currentCategories,
            },
            "moderate",
          ).allowed
        )
          return draft.reject("Moderation access is required.");
        if (!currentConfig.tombstones[original.id])
          return draft.reject("This removed message is no longer available.");
        if (targetThread)
          draft.update<Thread[]>("commsThreads", [], (all) =>
            all.map((item) =>
              item.id === targetThread.id
                ? {
                    ...item,
                    replies: [
                      ...threadMessages(item).filter(
                        (entry) => entry.id !== original.id,
                      ),
                      original,
                    ].sort((a, b) => a.created - b.created),
                  }
                : item,
            ),
          );
        else
          draft.update<Message[]>("commsMessages", MESSAGES, (all) =>
            [...all.filter((item) => item.id !== original.id), original].sort(
              (a, b) => a.created - b.created,
            ),
          );
        stageCommsConfiguration(draft, (current) => {
          const tombstones = { ...current.tombstones };
          delete tombstones[original.id];
          return { ...current, tombstones };
        });
        return null;
      },
      [
        COMMS_CONFIGURATION_KEY,
        "commsMessages",
        "commsThreads",
        "commsChannels",
        "commsCategories",
        "access-people",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The message could not be restored."),
    );
    if (result) {
      setError(result);
      return;
    }
    setStatus("Message restored.");
  }
  async function sendNow() {
    if (!selectedSchedule) return;
    const scheduleId = selectedSchedule.id;
    const result = await run(
      `schedule:send:${scheduleId}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentSchedule = currentConfig.schedules.find(
          (item) => item.id === scheduleId,
        );
        const currentChannels = draft.read("commsChannels", CHANNELS);
        const currentCategories = draft.read("commsCategories", CATEGORIES);
        const currentDirects = draft.read<Direct[]>("commsDirects", []);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentRoles = draft.read("access-roles", initialRoles);
        const currentRecords = draft.read("records", INITIAL_RECORDS);
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentThreads = draft.read<Thread[]>("commsThreads", []);
        if (!currentSchedule)
          return draft.reject("This scheduled message no longer exists.");
        const target = currentChannels.find(
          (item) => item.id === currentSchedule.channelId,
        );
        const recipient = currentDirects.find(
          (item) => item.id === currentSchedule.channelId,
        );
        if (!target && !recipient)
          return draft.reject("The scheduled conversation is unavailable.");
        if (recipient?.blocked)
          return draft.reject("Unblock this conversation before sending.");
        const error = validateCommsMessage({
          config: currentConfig,
          person: currentPeople.find(
            (person) => person.id === currentSchedule.authorId,
          ),
          channel: target,
          categories: currentCategories,
          people: currentPeople,
          roles: currentRoles,
          messages: toolChannelMessages(
            currentMessages,
            currentThreads,
            currentSchedule.channelId,
          ),
          text: currentSchedule.text,
          files: [],
          record: currentRecords.find(
            (record) => record.id === currentSchedule.recordId,
          ),
          kind: "post",
        });
        if (error) return draft.reject(error);
        draft.update<Message[]>("commsMessages", MESSAGES, (all) => [
          ...all,
          {
            id: crypto.randomUUID(),
            conversation: currentSchedule.channelId,
            text: currentSchedule.text,
            author: "You",
            authorId: currentSchedule.authorId,
            created: Date.now(),
            pinned: false,
            ...(currentSchedule.recordId
              ? { recordId: currentSchedule.recordId }
              : {}),
          },
        ]);
        stageCommsConfiguration(draft, (current) => ({
          ...current,
          schedules: current.schedules.filter((item) => item.id !== scheduleId),
        }));
        return null;
      },
      [
        COMMS_CONFIGURATION_KEY,
        "commsMessages",
        "commsThreads",
        "commsChannels",
        "commsCategories",
        "commsDirects",
        "access-people",
        "access-roles",
        "records",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The scheduled message could not be sent."),
    );
    if (result) {
      setError(result);
      return;
    }
    setScheduleId("");
    setPreview(false);
    setStatus(
      "Message added to the conversation. No external message was sent.",
    );
  }
  async function cancelSchedule(scheduleId: string) {
    const result = await run(
      `schedule:cancel:${scheduleId}`,
      (draft) => {
        const current = readCommsConfiguration(draft);
        if (!current.schedules.some((item) => item.id === scheduleId))
          return draft.reject("This scheduled message no longer exists.");
        stageCommsConfiguration(draft, (value) => ({
          ...value,
          schedules: value.schedules.filter((item) => item.id !== scheduleId),
        }));
        return null;
      },
      [COMMS_CONFIGURATION_KEY],
    ).catch((error: unknown) =>
      messageFromCommsError(
        error,
        "The scheduled message could not be cancelled.",
      ),
    );
    if (result) {
      setError(result);
      return;
    }
    setScheduleId("");
    setDirty(false);
    setPreview(false);
  }
  async function updateModeration(action: "restrict" | "clear" | "lock") {
    const result = await run(
      `moderation:${action}:${moderationChannel}`,
      (draft) => {
        const current = readCommsConfiguration(draft);
        const currentChannels = draft.read("commsChannels", CHANNELS);
        const currentCategories = draft.read("commsCategories", CATEGORIES);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentViewer = currentPeople.find(
          (person) => person.id === "sample-eli" && person.active,
        );
        const target = currentChannels.find(
          (item) => item.id === moderationChannel,
        );
        if (!target || !currentViewer)
          return draft.reject("Select an available channel.");
        if (
          !resolveCommsPermission(
            current,
            {
              person: currentViewer,
              channel: target,
              categories: currentCategories,
            },
            "moderate",
          ).allowed
        )
          return draft.reject("Moderation access is required.");
        if (action === "restrict") {
          if (
            !restrictedId ||
            !Number.isFinite(restrictionHours) ||
            restrictionHours < 1
          )
            return draft.reject("Select a person and positive duration.");
          const scope = { kind: "channel" as const, id: target.id };
          const before = getCommsScope(current, scope);
          const settings = resolveCommsSettings(
            current,
            target,
            currentCategories,
          ).values;
          stageCommsConfiguration(draft, (value) =>
            recordScopeChange(
              value,
              scope,
              {
                ...before,
                settings: {
                  ...before.settings,
                  restrictedPersonIds: [
                    ...new Set([...settings.restrictedPersonIds, restrictedId]),
                  ],
                  restrictionUntil: Date.now() + restrictionHours * 3600000,
                },
              },
              "Temporary posting restriction",
            ),
          );
        } else if (action === "clear") {
          const scope = { kind: "channel" as const, id: target.id };
          const before = getCommsScope(current, scope);
          stageCommsConfiguration(draft, (value) =>
            recordScopeChange(
              value,
              scope,
              {
                ...before,
                settings: { ...before.settings, restrictedPersonIds: [] },
              },
              "Cleared posting restrictions",
            ),
          );
        } else {
          const scope = { kind: "channel" as const, id: target.id };
          const before = getCommsScope(current, scope);
          const settings = resolveCommsSettings(
            current,
            target,
            currentCategories,
          ).values;
          stageCommsConfiguration(draft, (value) =>
            recordScopeChange(
              value,
              scope,
              {
                ...before,
                settings: { ...before.settings, locked: !settings.locked },
              },
              "Changed channel lock",
            ),
          );
        }
        return null;
      },
      [
        COMMS_CONFIGURATION_KEY,
        "commsChannels",
        "commsCategories",
        "access-people",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The moderation change could not be saved."),
    );
    if (result) {
      setError(result);
      return;
    }
    setStatus(
      action === "restrict"
        ? "Posting restriction applied."
        : action === "clear"
          ? "Channel posting restrictions cleared."
          : "Channel lock updated.",
    );
  }
  async function resolveReport(reportId: string) {
    const result = await run(
      `report:resolve:${reportId}`,
      (draft) => {
        stageCommsConfiguration(draft, (current) => ({
          ...current,
          reports: current.reports.map((report) =>
            report.id === reportId
              ? { ...report, status: "resolved" as const }
              : report,
          ),
        }));
        return null;
      },
      [COMMS_CONFIGURATION_KEY],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The report could not be resolved."),
    );
    if (result) setError(result);
  }
  async function removeReportedMessage(messageToRemove: Message) {
    const result = await run(
      `moderation:remove:${messageToRemove.id}`,
      (draft) => {
        const current = readCommsConfiguration(draft);
        const currentChannels = draft.read("commsChannels", CHANNELS);
        const currentCategories = draft.read("commsCategories", CATEGORIES);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentThreads = draft.read<Thread[]>("commsThreads", []);
        const currentViewer = currentPeople.find(
          (person) => person.id === "sample-eli" && person.active,
        );
        const sourceThread = currentThreads.find(
          (item) => item.id === messageToRemove.conversation,
        );
        const target = currentChannels.find(
          (item) =>
            item.id ===
            (sourceThread?.conversation ?? messageToRemove.conversation),
        );
        if (
          !currentViewer ||
          !resolveCommsPermission(
            current,
            {
              person: currentViewer,
              channel: target,
              categories: currentCategories,
            },
            "moderate",
          ).allowed
        )
          return draft.reject("Moderation access is required.");
        if (
          !currentMessages.some((item) => item.id === messageToRemove.id) &&
          !currentThreads.some((item) =>
            threadMessages(item).some(
              (entry) => entry.id === messageToRemove.id,
            ),
          )
        )
          return draft.reject("This message is no longer available.");
        stageCommsConfiguration(draft, (value) => ({
          ...value,
          tombstones: {
            ...value.tombstones,
            [messageToRemove.id]: messageToRemove,
          },
        }));
        draft.update<Message[]>("commsMessages", MESSAGES, (all) =>
          all.filter((item) => item.id !== messageToRemove.id),
        );
        draft.update<Thread[]>("commsThreads", [], (all) =>
          all.map((item) => ({
            ...item,
            replies: threadMessages(item).filter(
              (entry) => entry.id !== messageToRemove.id,
            ),
          })),
        );
        return null;
      },
      [
        COMMS_CONFIGURATION_KEY,
        "commsMessages",
        "commsThreads",
        "commsChannels",
        "commsCategories",
        "access-people",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The message could not be removed."),
    );
    if (result) {
      setError(result);
      return;
    }
    setStatus("Message removed and kept recoverable.");
  }
  const retainMessages = [
    ...messages.filter((m) => !channel || m.conversation === channel.id),
    ...threads
      .filter((t) => !channel || t.conversation === channel.id)
      .flatMap(threadMessages),
  ];
  const impacted =
    days > 0
      ? retainMessages.filter((m) => m.created < previewTime - days * 86400000)
      : [];
  return (
    <ConfigurationFrame
      title={titles[view]}
      opener={opener}
      onClose={onClose}
      dirty={dirty}
      onSave={
        ["report", "thread"].includes(view) ||
        (view === "outbox" && (selectedSchedule || creatingSchedule))
          ? save
          : undefined
      }
      saveLabel={view === "report" ? "Submit report" : "Save changes"}
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
        {view === "thread" && (
          <>
            {!thread ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Thread no longer exists.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="tools-dialog-field-1">
                    Thread name
                  </FieldLabel>
                  <Input
                    id="tools-dialog-field-1"
                    value={meta.name ?? ""}
                    onChange={(e) => {
                      setMeta({ ...meta, name: e.target.value });
                      setDirty(true);
                    }}
                  />
                </Field>
                {(["locked", "resolved", "archived"] as const).map((k) => (
                  <Field key={k} className="flex-row items-center gap-2">
                    <Checkbox
                      id={`tools-dialog-field-2-${k}`}
                      checked={meta[k] ?? false}
                      onCheckedChange={(checked) => {
                        setMeta({ ...meta, [k]: checked });
                        setDirty(true);
                      }}
                    />
                    <FieldLabel htmlFor={`tools-dialog-field-2-${k}`}>
                      {k[0].toUpperCase() + k.slice(1)}
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
                          ? [
                              ...new Set([
                                ...(meta.followedBy ?? []),
                                "sample-eli",
                              ]),
                            ]
                          : (meta.followedBy ?? []).filter(
                              (id) => id !== "sample-eli",
                            ),
                      });
                      setDirty(true);
                    }}
                  />
                  <FieldLabel htmlFor="tools-dialog-field-3">
                    Follow thread
                  </FieldLabel>
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
            )}
          </>
        )}
        {view === "report" && (
          <>
            <Card className="w-full">
              <CardHeader>
                <CardTitle>Reported message</CardTitle>
              </CardHeader>
              <CardContent>
                <blockquote>
                  {message?.text ?? "Message unavailable"}
                </blockquote>
              </CardContent>
            </Card>
            <Field>
              <FieldLabel htmlFor="tools-dialog-field-4">Reason</FieldLabel>
              <Textarea
                id="tools-dialog-field-4"
                className="min-h-28"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setDirty(true);
                }}
              />
            </Field>
          </>
        )}
        {view === "message-history" && (
          <>
            {!config.messageHistory[messageId ?? ""]?.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No saved edits for this message.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {(config.messageHistory[messageId ?? ""] ?? []).map((m, i) => (
              <Card key={`${m.id}-${i}`} role="article" className="w-full">
                <CardHeader>
                  <CardTitle>Version {i + 1}</CardTitle>
                  <CardDescription>
                    {new Date(m.created).toLocaleString()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="break-words whitespace-pre-wrap">{m.text}</p>
                </CardContent>
              </Card>
            ))}
            {message && (
              <Card role="article" className="w-full">
                <CardHeader>
                  <CardTitle>Current message</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="break-words whitespace-pre-wrap">
                    {message.text}
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
        {view === "history" && (
          <>
            {!config.history.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No configuration changes yet.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {config.history.map((entry) => (
              <Card key={entry.id} role="article" className="w-full">
                <CardHeader>
                  <CardTitle>{entry.label}</CardTitle>
                  <CardDescription>
                    {new Date(entry.created).toLocaleString()} ·{" "}
                    {entry.scope.kind}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Collapsible>
                    <CollapsibleTrigger
                      render={
                        <Button
                          variant="ghost"
                          className="justify-between px-0"
                        />
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
                        names={Object.fromEntries(
                          [...people, ...roles, ...records].map((item) => [
                            item.id,
                            "name" in item ? item.name : item.title,
                          ]),
                        )}
                      />
                    </CollapsibleContent>
                  </Collapsible>
                  <Separator />
                  <Button variant="outline" onClick={() => setRestore(entry)}>
                    Preview restoration
                  </Button>
                </CardContent>
              </Card>
            ))}
            {restore && (
              <Card aria-label="Restoration preview" className="w-full">
                <CardHeader>
                  <CardTitle>Restore {restore.label}</CardTitle>
                  <CardDescription>
                    Replaces this scope’s current overrides with the saved
                    before-values
                    {restore.beforeLocks ? " and workspace locks" : ""}. Other
                    scopes and conversations remain unchanged.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <ConfigurationChanges
                    before={getCommsScope(config, restore.scope)}
                    after={restore.before}
                    beforeLocks={
                      restore.beforeLocks
                        ? {
                            settings: config.lockedSettings,
                            permissions: config.lockedPermissions,
                          }
                        : undefined
                    }
                    afterLocks={restore.beforeLocks}
                    names={Object.fromEntries(
                      [...people, ...roles, ...records].map((item) => [
                        item.id,
                        "name" in item ? item.name : item.title,
                      ]),
                    )}
                  />

                  <Button
                    onClick={() => {
                      if (!allowed("manageWorkspace")) {
                        setError("Workspace management access is required.");
                        return;
                      }
                      void (async () => {
                        const result = await run(
                          `configuration:restore:${restore.id}`,
                          (draft) => {
                            stageCommsConfiguration(draft, (current) =>
                              restoreConfigurationEntry(current, restore),
                            );
                            return null;
                          },
                          [COMMS_CONFIGURATION_KEY],
                        ).catch((error: unknown) =>
                          messageFromCommsError(
                            error,
                            "Configuration could not be restored.",
                          ),
                        );
                        if (result) {
                          setError(result);
                          return;
                        }
                        setRestore(null);
                        setStatus("Configuration restored.");
                      })();
                    }}
                  >
                    Confirm restoration
                  </Button>
                  <Button variant="outline" onClick={() => setRestore(null)}>
                    Cancel restoration
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}
        {view === "retention" && (
          <>
            <p className="text-sm">
              Inspect the effect of a retention period. This preview never
              purges content.
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
                onChange={(e) => setDays(Math.max(0, Number(e.target.value)))}
              />
            </Field>
            <Alert role="status">
              {impacted.length} of {retainMessages.length} messages would be
              affected.
            </Alert>
            {impacted.map((m) => (
              <Card key={m.id} className="w-full">
                <CardHeader>
                  <CardTitle>{m.author}</CardTitle>
                  <CardDescription>
                    {new Date(m.created).toLocaleString()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p>{m.text}</p>
                </CardContent>
              </Card>
            ))}
          </>
        )}
        {view === "outbox" && (
          <>
            <p className="text-muted-foreground text-sm">
              Scheduled messages are not delivered automatically. Messages send
              only when you choose Send Now.
            </p>
            {!config.schedules.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No scheduled messages.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {config.schedules.map((s) => (
              <Card key={s.id} className="w-full">
                <CardHeader>
                  <CardTitle>Scheduled message</CardTitle>
                  <CardDescription>
                    {new Date(s.sendAt).toLocaleString()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    className="h-auto justify-start text-left whitespace-normal"
                    aria-label={`${s.text} · ${new Date(s.sendAt).toLocaleString()}`}
                    onClick={() => {
                      setScheduleId(s.id);
                      setCreatingSchedule(false);
                      setText(s.text);
                      setSendAt(
                        new Date(
                          s.sendAt -
                            new Date(s.sendAt).getTimezoneOffset() * 60000,
                        )
                          .toISOString()
                          .slice(0, 16),
                      );
                      setPreview(false);
                      setDirty(false);
                    }}
                  >
                    {s.text}
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
                    onChange={(e) => {
                      setText(e.target.value);
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
                    onChange={(e) => {
                      setSendAt(e.target.value);
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
                      <Button onClick={sendNow}>Send Now</Button>
                    </CardContent>
                  </Card>
                )}
                {selectedSchedule && (
                  <Button
                    variant="outline"
                    onClick={() => void cancelSchedule(selectedSchedule.id)}
                  >
                    Cancel scheduled message
                  </Button>
                )}
              </>
            )}
          </>
        )}
        {view === "moderation" && (
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
                  onChange={(e) => setModerationChannel(e.target.value)}
                >
                  {channels.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      #{c.name}
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
                  onChange={(e) => setRestrictedId(e.target.value)}
                >
                  <NativeSelectOption value="">
                    Select a person
                  </NativeSelectOption>
                  {people
                    .filter((p) => p.active)
                    .map((p) => (
                      <NativeSelectOption key={p.id} value={p.id}>
                        {p.name}
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
                  onChange={(e) => setRestrictionHours(Number(e.target.value))}
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
                    channels.find((c) => c.id === moderationChannel),
                    categories,
                  ).values.locked
                    ? "Unlock channel"
                    : "Lock channel"}
                </Button>
              </div>
            </FieldSet>
            <Separator />
            <h3 className="font-medium">Message reports</h3>
            {!config.reports.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No reported messages.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {config.reports.map((report) => {
              const m =
                messages.find((m) => m.id === report.messageId) ??
                threads
                  .flatMap(threadMessages)
                  .find((m) => m.id === report.messageId);
              return (
                <Card key={report.id} role="article" className="w-full">
                  <CardHeader>
                    <CardTitle>{report.reason}</CardTitle>
                    <CardDescription>{report.status}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <blockquote className="text-muted-foreground text-sm">
                      {m?.text ?? "Message removed"}
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
                    {m && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (!allowed("moderate")) return;
                          void removeReportedMessage(m);
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
            <h3 className="font-medium">Recoverable messages</h3>
            {!Object.keys(config.tombstones).length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No removed messages.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {Object.values(config.tombstones).map((m) => (
              <Card key={m.id} role="article" className="w-full">
                <CardHeader>
                  <CardTitle>{m.author}</CardTitle>
                  <CardDescription>
                    {new Date(m.created).toLocaleString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm break-words">{m.text}</p>
                  <Separator />
                  <Button
                    variant="outline"
                    onClick={() => void restoreMessage(m)}
                  >
                    Restore message
                  </Button>
                </CardContent>
              </Card>
            ))}
          </>
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}

function ConfigurationChanges({
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
