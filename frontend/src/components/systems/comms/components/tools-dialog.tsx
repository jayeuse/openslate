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
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";

import { useCommsConfiguration } from "../state/configuration-state";
import {
  getCommsScope,
  resolveCommsSettings,
  resolveCommsPermission,
  type CommsHistoryEntry,
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
import { initialPeople, initialRoles } from "../../shared/data/sample-people";
import { INITIAL_RECORDS } from "../../shared/data/sample-data";
import {
  recordScopeChange,
  restoreConfigurationEntry,
  toolChannelMessages,
} from "../domain/tools-helpers";
import {
  ConfigurationChanges,
  ConfigurationHistoryFields,
  MessageHistoryFields,
  RetentionPreviewFields,
} from "./tools-history-sections";
import {
  MessageReportFields,
  OutboxFields,
  ThreadSettingsFields,
} from "./tools-conversation-sections";
import { ModerationFields } from "./tools-moderation-section";
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
// Titles match the OpenComms menu labels that open them.
const titles: Record<CommsToolsView, string> = {
  management: "Bulk channel changes",
  templates: "Channel templates",
  automation: "Automation",
  history: "Settings history",
  moderation: "Moderation",
  outbox: "Scheduled messages",
  retention: "Message retention",
  thread: "Thread settings",
  "message-history": "Message history",
  report: "Report message",
};
const descriptions: Partial<Record<CommsToolsView, string>> = {
  history: "Every settings change. Preview one to restore its earlier values.",
  moderation:
    "Review reports, limit who can post, and restore removed messages.",
  outbox:
    "Messages set to send later. In this example, nothing is sent outside OpenComms.",
  retention:
    "See which messages a retention period would remove. Nothing is deleted.",
  "message-history": "Earlier versions of this message.",
  report: "Tell moderators what is wrong with this message.",
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
  const entityNames = Object.fromEntries(
    [...people, ...roles, ...records].map((item) => [
      item.id,
      "name" in item ? item.name : item.title,
    ]),
  );
  return (
    <ConfigurationFrame
      title={titles[view]}
      description={descriptions[view]}
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
          <ThreadSettingsFields
            thread={thread}
            meta={meta}
            setMeta={setMeta}
            setDirty={setDirty}
            config={config}
            channel={channel}
            categories={categories}
          />
        )}
        {view === "report" && (
          <MessageReportFields
            messageText={message?.text}
            reason={reason}
            setReason={setReason}
            setDirty={setDirty}
          />
        )}
        {view === "message-history" && (
          <MessageHistoryFields
            history={config.messageHistory[messageId ?? ""] ?? []}
            currentMessage={message}
          />
        )}
        {view === "history" && (
          <>
            <ConfigurationHistoryFields
              history={config.history}
              names={entityNames}
              onPreview={setRestore}
            />
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
                    names={entityNames}
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
          <RetentionPreviewFields
            days={days}
            setDays={setDays}
            impacted={impacted}
            total={retainMessages.length}
          />
        )}
        {view === "outbox" && (
          <OutboxFields
            config={config}
            selectedSchedule={selectedSchedule}
            creatingSchedule={creatingSchedule}
            setCreatingSchedule={setCreatingSchedule}
            setScheduleId={setScheduleId}
            text={text}
            setText={setText}
            sendAt={sendAt}
            setSendAt={setSendAt}
            dirty={dirty}
            setDirty={setDirty}
            preview={preview}
            setPreview={setPreview}
            onSendNow={() => void sendNow()}
            onCancelSchedule={(id) => void cancelSchedule(id)}
          />
        )}
        {view === "moderation" && (
          <ModerationFields
            config={config}
            channels={channels}
            categories={categories}
            people={people}
            messages={messages}
            threads={threads}
            moderationChannel={moderationChannel}
            setModerationChannel={setModerationChannel}
            restrictedId={restrictedId}
            setRestrictedId={setRestrictedId}
            restrictionHours={restrictionHours}
            setRestrictionHours={setRestrictionHours}
            updateModeration={updateModeration}
            allowed={allowed}
            resolveReport={resolveReport}
            removeReportedMessage={removeReportedMessage}
            restoreMessage={restoreMessage}
          />
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
