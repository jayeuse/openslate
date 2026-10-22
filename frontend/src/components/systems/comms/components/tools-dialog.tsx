"use client";
import { useEffect, useRef, useState } from "react";
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
import { NativeSelectOption } from "@/components/ui/native-select";
import { Choice, Toggle } from "../../shared/components/ui";
import type * as C from "../contract/types";
import {
  ConfigurationFrame,
  type ConfigurationFrameProps,
} from "./configuration-frame";
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
  type ThreadDraft,
} from "./tools-conversation-sections";
import { ModerationFields } from "./tools-moderation-section";
import { ManagementTools } from "./tools-management";
import { ExportTools } from "./tools-export";
import { ToolAdvanced } from "./tool-advanced";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { datetimeInputToUtc, formatDateTimeLocal } from "@/lib/date-time";
import { TextField } from "./message-shared";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useVisiblePeople } from "../state/use-visible-people";
import { useCommsClient } from "../state/client-context";
import { complete } from "../state/workspace-view";
import {
  isCommsConflict,
  messageFromCommsError,
  STALE_PREVIEW_MESSAGE,
  useCommsCommands,
  useCommsRead,
} from "../state/runtime";

export type CommsToolsView =
  | "templates"
  | "history"
  | "moderation"
  | "outbox"
  | "retention"
  | "export"
  | "thread"
  | "message-history"
  | "report";
export interface CommsToolsDialogProps {
  embedded?: ConfigurationFrameProps["embedded"];
  view: CommsToolsView;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  opener: HTMLElement | null;
  onClose: () => void;
}
const titles: Record<CommsToolsView, string> = {
  export: "Export messages",
  templates: "Channel templates",
  history: "Settings history",
  moderation: "Moderation",
  outbox: "Scheduled messages",
  retention: "Message retention",
  thread: "Thread settings",
  "message-history": "Message history",
  report: "Report message",
};
export function CommsToolsDialog(props: CommsToolsDialogProps) {
  return props.view === "export" ? (
    <ExportTools {...props} />
  ) : props.view === "templates" ? (
    <ManagementTools {...props} />
  ) : (
    <LifecycleTools {...props} />
  );
}
type ToolData = {
  reports: C.Report[];
  removed: C.Tombstone[];
  schedules: C.Schedule[];
  history: C.ConfigurationHistory[];
  revisions: C.MessageRevision[];
  settings?: C.Settings;
  retention?: C.Versioned<C.RetentionResponse>;
};
function LifecycleTools({
  embedded,
  view,
  channelId,
  threadId,
  messageId,
  opener,
  onClose,
}: CommsToolsDialogProps) {
  const { client: admittedClient } = useCommsClient();
  const [password, setPassword] = useState("");
  useEffect(() => setPassword(""), [admittedClient]);
  const workspace = useCommsWorkspaceView();
  const region = useWorkspaceDisplayRegion();
  const { run, isPending } = useCommsCommands();
  const { channels, messages, threads } = workspace;
  // Moderation and history name people from everyone in the viewer's
  // conversations; other tools need no people read.
  const people = useVisiblePeople(
    view === "moderation" || view === "history" || view === "message-history",
  );
  const thread = threads.find((item) => item.id === threadId);
  const message = [
    ...messages,
    ...threads.flatMap((thread) => thread.replies),
  ].find((item) => item.id === messageId);
  const conversationId =
    channelId ??
    thread?.conversation ??
    message?.conversation ??
    channels[0]?.id ??
    "";
  const [moderationChannel, setModerationChannel] = useState(conversationId);
  const [retentionTarget, setRetentionTarget] = useState("workspace");
  const retentionScope: C.RetentionPolicy["scope"] =
    retentionTarget === "workspace"
      ? { kind: "workspace" }
      : { kind: "channel", id: retentionTarget };
  const resource = useCommsRead<ToolData>(
    `tool:${view}:${conversationId}:${moderationChannel}:${retentionTarget}:${messageId ?? ""}`,
    async (client, signal) => {
      const options = { signal };
      const data: ToolData = {
        reports: [],
        removed: [],
        schedules: [],
        history: [],
        revisions: [],
      };
      if (view === "moderation") {
        data.reports = await complete((offset) =>
          client.listReports({ limit: 100, offset }, options),
        );
        if (moderationChannel) {
          data.removed = await complete((offset) =>
            client.listRemovedMessages(
              moderationChannel,
              { limit: 100, offset },
              options,
            ),
          );
          data.settings = (
            await client.getSettings(
              { kind: "channel", id: moderationChannel },
              options,
            )
          ).data.effective;
        }
      } else if (view === "outbox")
        data.schedules = await complete((offset) =>
          client.listSchedules({ limit: 100, offset }, options),
        );
      else if (view === "history") {
        const bootstrap = await client.bootstrap(options);
        const scopes: C.SettingsScope[] = [
          { kind: "workspace" },
          ...bootstrap.categories.map(({ category }) => ({
            kind: "category" as const,
            id: category.id,
          })),
          ...bootstrap.conversations.flatMap(({ conversation }) =>
            conversation.kind === "channel"
              ? [{ kind: "channel" as const, id: conversation.id }]
              : [],
          ),
        ];
        for (const scope of scopes)
          data.history.push(
            ...(await complete((offset) =>
              client.listConfigurationHistory(
                scope,
                { limit: 100, offset },
                options,
              ),
            )),
          );
        data.history.sort(
          (a, b) =>
            Date.parse(a.created_at) - Date.parse(b.created_at) ||
            a.id.localeCompare(b.id),
        );
      } else if (view === "message-history" && messageId)
        data.revisions = await complete((offset) =>
          client.listMessageRevisions(
            conversationId,
            messageId,
            { limit: 100, offset },
            options,
          ),
        );
      else if (view === "retention")
        data.retention = await client.getRetention(retentionScope, options);
      else if (view === "thread" && conversationId)
        data.settings = (
          await client.getSettings(
            channels.some((channel) => channel.id === conversationId)
              ? { kind: "channel", id: conversationId }
              : { kind: "workspace" },
            options,
          )
        ).data.effective;
      return data;
    },
  );
  const [meta, setMeta] = useState<ThreadDraft>({
    name: thread?.name ?? "",
    resolved: thread?.resolved ?? false,
    locked: thread?.locked ?? false,
    archived: thread?.archived ?? false,
    followed: thread?.subscribed ?? false,
  });
  const confirmedMeta = useRef<ThreadDraft | null>(null);
  const [reason, setReason] = useState("");
  const reportSaved = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const proofReady = password.length > 0;
  const [days, setDays] = useState(0);
  const [fileDays, setFileDays] = useState(0);
  const [inheritFiles, setInheritFiles] = useState(false);
  const [inheritRetention, setInheritRetention] = useState(false);
  const [retentionPreview, setRetentionPreview] = useState<{
    value: C.RetentionPreview;
    etag: string;
    policy: C.RetentionPolicy;
  }>();
  const [restore, setRestore] = useState<{
    entry: C.ConfigurationHistory;
    preview: C.Versioned<C.ConfigurationRestorePreview>;
  }>();
  const [historyId, setHistoryId] = useState("");
  const [scheduleId, setScheduleId] = useState("");
  const createdSchedule = useRef<string | null>(null);
  const scheduleKey = useRef<string | null>(null);
  const selectedSchedule = resource.data?.schedules.find(
    (row) => row.id === scheduleId,
  );
  const [creatingSchedule, setCreatingSchedule] = useState(
    view === "outbox" && !!message,
  );
  const [text, setText] = useState(
    view === "outbox" ? (message?.text ?? "") : "",
  );
  const [sendAt, setSendAt] = useState("");
  const [originalTime, setOriginalTime] = useState<{
    instant: string;
    timezone: string;
  }>();
  const [utcOffset, setUtcOffset] = useState("");
  const timezone = region?.timezone ?? "UTC";
  const timeUnchanged =
    !!originalTime &&
    originalTime.timezone === timezone &&
    formatDateTimeLocal(originalTime.instant, timezone) === sendAt;
  const [preview, setPreview] = useState(false);
  const [restrictedId, setRestrictedId] = useState("");
  const [restrictionHours, setRestrictionHours] = useState(24);
  useEffect(() => {
    if (dirty || !resource.data?.retention) return;
    setDays(resource.data.retention.data.effective.message_days);
    setFileDays(resource.data.retention.data.effective.file_days);
    setInheritFiles(resource.data.retention.data.policy.file_days === null);
    setInheritRetention(
      resource.data.retention.data.policy.message_days === null,
    );
  }, [resource.data?.retention, dirty]);
  async function action(
    key: string,
    operation: Parameters<typeof run<void>>[1],
    success?: string,
    /** Drops a stale preview so a 412 apply needs a fresh preview. */
    onStalePreview?: () => void,
  ) {
    setError("");
    setStatus("");
    try {
      await run(key, operation);
      if (success) setStatus(success);
      resource.reload();
      return true;
    } catch (failure) {
      const stale = !!onStalePreview && isCommsConflict(failure);
      if (stale) onStalePreview();
      setError(
        messageFromCommsError(
          failure,
          "The change could not be completed. Your draft is still here.",
          stale ? STALE_PREVIEW_MESSAGE : undefined,
        ),
      );
      return false;
    } finally {
      setPassword("");
    }
  }
  async function save() {
    let editedSendAt: string | undefined;
    if (view === "outbox" && !timeUnchanged) {
      try {
        editedSendAt = datetimeInputToUtc(
          sendAt,
          timezone,
          utcOffset || undefined,
        );
      } catch (failure) {
        setStatus("");
        setError(
          failure instanceof Error
            ? failure.message
            : "Choose a valid scheduled time.",
        );
        return false;
      }
    }
    let confirmedWrite = false;
    const ok = await action(`save:${view}`, async (client, signal) => {
      const options = { signal };
      if (view === "report") {
        if (!messageId || !reason.trim())
          throw new Error("Enter a report reason");
        if (!reportSaved.current) {
          await client.reportMessage(
            conversationId,
            messageId,
            { reason: reason.trim() },
            options,
          );
          reportSaved.current = true;
        }
        confirmedWrite = true;
      } else if (view === "thread") {
        if (!thread) throw new Error("Thread is unavailable");
        const current = await client.getThread(
          thread.conversation,
          thread.messageId,
          options,
        );
        const before = confirmedMeta.current ?? {
          ...current.data,
          followed: current.data.followed,
        };
        const patch = Object.fromEntries(
          (["name", "locked", "resolved", "archived"] as const)
            .filter((key) => before[key] !== meta[key])
            .map((key) => [key, meta[key]]),
        );
        if (Object.keys(patch).length) {
          await client.updateThread(
            thread.conversation,
            thread.messageId,
            patch,
            { ...options, if_match: current.etag },
          );
          confirmedMeta.current = { ...meta, followed: before.followed };
          confirmedWrite = true;
        }
        if ((confirmedMeta.current ?? before).followed !== meta.followed) {
          await client.followThread(
            thread.conversation,
            thread.messageId,
            { followed: meta.followed },
            options,
          );
          confirmedMeta.current = { ...meta };
          confirmedWrite = true;
        }
      } else if (view === "outbox") {
        const id = scheduleId || createdSchedule.current;
        const current = id ? await client.getSchedule(id, options) : undefined;
        // Body-only edits keep the stored instant (including its offset choice
        // and sub-minute precision), also retaining a concurrent time change.
        const requestedTime = timeUnchanged
          ? current?.data.request.send_at
          : editedSendAt;
        if (!requestedTime) throw new Error("Choose a valid scheduled time.");
        scheduleKey.current ??= crypto.randomUUID();
        const request: C.ScheduleRequest = {
          ...(current?.data.request ?? {
            client_key: scheduleKey.current,
            conversation_id: conversationId,
            attachment_ids: [],
            record_ids: [],
            mention_user_ids: [],
            mentions_channel: false,
            mentions_here: false,
            reply_to_id: null,
            parent_id: null,
            also_send_to_channel: false,
          }),
          body: text,
          send_at: requestedTime,
        };
        const accepted = current
          ? await client.updateSchedule(current.data.id, request, {
              ...options,
              if_match: current.etag,
            })
          : await client.createSchedule(request, options);
        createdSchedule.current = accepted.data.id;
        setOriginalTime({ instant: accepted.data.request.send_at, timezone });
        setSendAt(formatDateTimeLocal(accepted.data.request.send_at, timezone));
        setUtcOffset("");
        confirmedWrite = true;
      }
    });
    if (!ok) {
      if (confirmedWrite)
        setError(
          "Some changes were saved. Your remaining changes are still here. Review them and try again.",
        );
      return false;
    }
    setDirty(false);
    if (view === "outbox") {
      setScheduleId(createdSchedule.current ?? scheduleId);
      setCreatingSchedule(false);
      setStatus("Scheduled message saved.");
    } else onClose();
    return true;
  }
  const names = Object.fromEntries(
    [...people, ...channels].map((item) => [item.id, item.name]),
  );
  const protectedView = view === "history" || view === "retention";
  return (
    <ConfigurationFrame
      embedded={embedded}
      className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
      title={titles[view]}
      description={
        view === "moderation"
          ? "Review reports, limit posting, and restore removed messages."
          : view === "retention"
            ? "Preview retention impact before confirming a protected change."
            : view === "history"
              ? "Preview a saved change before restoring its earlier values."
              : undefined
      }
      opener={opener}
      onClose={onClose}
      dirty={dirty}
      disabled={isPending() || (view === "outbox" && !region)}
      onSave={
        view === "report" ||
        view === "thread" ||
        (view === "outbox" &&
          (creatingSchedule || selectedSchedule?.status === "pending"))
          ? save
          : undefined
      }
      saveLabel={view === "report" ? "Submit report" : "Save changes"}
    >
      <FieldGroup className="p-5 sm:p-6">
        {(error || resource.error) && (
          <Alert role="alert" variant="destructive">
            {error || "Tool data could not be loaded."}
            {resource.error && (
              <Button variant="outline" onClick={resource.reload}>
                Try again
              </Button>
            )}
          </Alert>
        )}
        {status && (
          <Alert role="status" variant="success">
            {status}
          </Alert>
        )}
        {!resource.data && resource.status === "loading" && (
          <p role="status">Loading tool…</p>
        )}
        {protectedView && (
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isPending()}
          />
        )}
        {view === "thread" && (
          <ThreadSettingsFields
            thread={thread}
            meta={meta}
            setMeta={setMeta}
            setDirty={setDirty}
            settings={resource.data?.settings}
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
        {view === "message-history" && resource.data && (
          <MessageHistoryFields
            history={resource.data.revisions}
            currentMessage={message}
          />
        )}
        {view === "history" && resource.data && (
          <>
            <ConfigurationHistoryFields
              history={resource.data.history}
              names={names}
            />
            <ToolAdvanced tool="history">
              <Choice
                label="Change to restore"
                value={historyId}
                disabled={isPending()}
                onChange={(event) => {
                  setHistoryId(event.target.value);
                  setRestore(undefined);
                }}
              >
                <NativeSelectOption value="">
                  Select a saved change
                </NativeSelectOption>
                {resource.data.history.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.scope.kind} ·{" "}
                    {new Date(entry.created_at).toLocaleString()}
                  </NativeSelectOption>
                ))}
              </Choice>
              <Button
                variant="outline"
                disabled={!proofReady || isPending() || !historyId}
                onClick={() => {
                  const entry = resource.data?.history.find(
                    (row) => row.id === historyId,
                  );
                  if (!entry) return;
                  void action(
                    `history-preview:${entry.id}`,
                    async (client, signal) => {
                      const current = await client.getSettings(entry.scope, {
                        signal,
                      });
                      const preview = await client.previewConfigurationRestore(
                        entry.scope,
                        entry.id,
                        {
                          signal,
                          if_match: current.etag,
                          password,
                        },
                      );
                      setRestore({ entry, preview });
                    },
                  );
                }}
              >
                Preview restoration
              </Button>
              {restore && (
                <Card aria-label="Restoration preview" className="w-full">
                  <CardHeader>
                    <CardTitle>
                      Restore {restore.entry.scope.kind} settings
                    </CardTitle>
                    <CardDescription>
                      Replaces this scope’s overrides with the previewed values.
                      Other scopes remain unchanged.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <ConfigurationChanges
                      before={restore.preview.data.before}
                      after={restore.preview.data.after}
                      names={names}
                    />
                    <Button
                      disabled={!proofReady || isPending()}
                      onClick={() => {
                        void action(
                          `restore:${restore.entry.id}`,
                          async (client, signal) => {
                            await client.restoreConfiguration(
                              restore.entry.scope,
                              {
                                history_id: restore.entry.id,
                                preview_digest:
                                  restore.preview.data.preview_digest,
                              },
                              {
                                signal,
                                if_match: restore.preview.etag,
                                password,
                              },
                            );
                            setRestore(undefined);
                          },
                          "Configuration restored.",
                          () => setRestore(undefined),
                        );
                      }}
                    >
                      Confirm restoration
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setRestore(undefined)}
                    >
                      Cancel restoration
                    </Button>
                  </CardContent>
                </Card>
              )}
            </ToolAdvanced>
          </>
        )}
        {view === "retention" && (
          <>
            <p className="text-sm font-semibold">
              {retentionTarget === "workspace"
                ? "This organization's retention"
                : `Channel override: #${channels.find((row) => row.id === retentionTarget)?.name}`}
            </p>
            <RetentionPreviewFields
              days={days}
              setDays={(value) => {
                setDays(value);
                setDirty(true);
                setRetentionPreview(undefined);
              }}
              preview={retentionPreview?.value}
              disabled={!proofReady || isPending() || !resource.data?.retention}
              inherited={retentionTarget !== "workspace" && inheritRetention}
              onPreview={() => {
                void action("retention-preview", async (client, signal) => {
                  const current = await client.getRetention(retentionScope, {
                    signal,
                  });
                  const policy: C.RetentionPolicy =
                    retentionScope.kind === "workspace"
                      ? {
                          scope: retentionScope,
                          message_days: days,
                          file_days: fileDays,
                        }
                      : {
                          scope: retentionScope,
                          message_days: inheritRetention ? null : days,
                          file_days: inheritFiles ? null : fileDays,
                        };
                  const value = await client.previewRetention(policy, {
                    signal,
                    if_match: current.etag,
                    password,
                  });
                  setRetentionPreview({ value, policy, etag: current.etag });
                });
              }}
              onApply={() => {
                if (!retentionPreview) return;
                void action(
                  "retention-save",
                  async (client, signal) => {
                    await client.updateRetention(
                      {
                        ...retentionPreview.policy,
                        preview_digest: retentionPreview.value.preview_digest,
                      },
                      {
                        signal,
                        if_match: retentionPreview.etag,
                        password,
                      },
                    );
                    setRetentionPreview(undefined);
                    setDirty(false);
                  },
                  "Retention policy saved.",
                  () => setRetentionPreview(undefined),
                );
              }}
            />
            <ToolAdvanced tool="retention" count={Number(dirty)}>
              <Choice
                label="Retention scope"
                value={retentionTarget}
                disabled={dirty || isPending()}
                onChange={(event) => {
                  setRetentionTarget(event.target.value);
                  setRetentionPreview(undefined);
                }}
              >
                <NativeSelectOption value="workspace">
                  This organization
                </NativeSelectOption>
                {channels.map((channel) => (
                  <NativeSelectOption key={channel.id} value={channel.id}>
                    #{channel.name}
                  </NativeSelectOption>
                ))}
              </Choice>
              {retentionTarget !== "workspace" && (
                <>
                  <Toggle
                    label="Inherit organization message retention"
                    disabled={isPending()}
                    checked={inheritRetention}
                    onCheckedChange={(value) => {
                      setInheritRetention(value);
                      setDirty(true);
                      setRetentionPreview(undefined);
                    }}
                  />
                  <Toggle
                    label="Inherit organization file retention"
                    disabled={isPending()}
                    checked={inheritFiles}
                    onCheckedChange={(value) => {
                      setInheritFiles(value);
                      setDirty(true);
                      setRetentionPreview(undefined);
                    }}
                  />
                </>
              )}
              <TextField
                label="File retention days (0 keeps everything)"
                type="number"
                min={0}
                value={fileDays}
                disabled={
                  isPending() ||
                  (retentionTarget !== "workspace" && inheritFiles)
                }
                onChange={(event) => {
                  setFileDays(Number(event.target.value));
                  setDirty(true);
                  setRetentionPreview(undefined);
                }}
              />
            </ToolAdvanced>
          </>
        )}
        {view === "outbox" && resource.data && (
          <OutboxFields
            schedules={resource.data.schedules}
            selectedSchedule={selectedSchedule}
            creatingSchedule={creatingSchedule}
            onSelectSchedule={(schedule) => {
              setScheduleId(schedule.id);
              setCreatingSchedule(false);
              setText(schedule.request.body);
              setOriginalTime({ instant: schedule.request.send_at, timezone });
              setSendAt(
                formatDateTimeLocal(schedule.request.send_at, timezone),
              );
              setUtcOffset("");
              setPreview(false);
              setDirty(false);
            }}
            text={text}
            setText={setText}
            sendAt={sendAt}
            setSendAt={setSendAt}
            timeUnchanged={timeUnchanged}
            utcOffset={utcOffset}
            setUtcOffset={setUtcOffset}
            dirty={dirty}
            setDirty={setDirty}
            preview={preview}
            setPreview={setPreview}
            onSendNow={() => {
              if (!selectedSchedule) return;
              void action(
                `send-now:${selectedSchedule.id}`,
                async (client, signal) => {
                  const current = await client.getSchedule(
                    selectedSchedule.id,
                    { signal },
                  );
                  const result = await client.sendScheduleNow(current.data.id, {
                    signal,
                    if_match: current.etag,
                  });
                  if (result.status !== "succeeded")
                    throw new Error("Scheduled message did not send");
                },
                "Scheduled message sent.",
              );
            }}
            onCancelSchedule={(id) => {
              void action(
                `cancel:${id}`,
                async (client, signal) => {
                  const current = await client.getSchedule(id, { signal });
                  await client.cancelSchedule(id, {
                    signal,
                    if_match: current.etag,
                  });
                },
                "Scheduled message cancelled.",
              );
            }}
          />
        )}
        {view === "moderation" && resource.data && (
          <ModerationFields
            key={moderationChannel}
            channels={channels}
            people={people}
            messages={[
              ...messages,
              ...threads.flatMap((thread) => thread.replies),
            ]}
            reports={resource.data.reports}
            removed={resource.data.removed}
            settings={resource.data.settings}
            moderationChannel={moderationChannel}
            setModerationChannel={setModerationChannel}
            restrictedId={restrictedId}
            setRestrictedId={setRestrictedId}
            restrictionHours={restrictionHours}
            setRestrictionHours={setRestrictionHours}
            pending={isPending()}
            updateModeration={(operation, seconds) => {
              void action(
                `moderation:${moderationChannel}`,
                async (client, signal) => {
                  const scope = {
                    kind: "channel",
                    id: moderationChannel,
                  } as const;
                  const current = await client.getSettings(scope, { signal });
                  if (operation === "slow")
                    await client.updateSettings(
                      scope,
                      { slow_mode_seconds: seconds ?? 0 },
                      { signal, if_match: current.etag },
                    );
                  else if (operation === "lock")
                    await client.updateSettings(
                      scope,
                      { locked: !current.data.effective.locked },
                      { signal, if_match: current.etag },
                    );
                  else
                    await client.setPostingRestrictions(
                      moderationChannel,
                      {
                        user_ids:
                          operation === "clear"
                            ? []
                            : [
                                ...new Set([
                                  ...current.data.effective
                                    .restricted_person_ids,
                                  restrictedId,
                                ]),
                              ],
                        until:
                          operation === "clear"
                            ? null
                            : new Date(
                                Date.now() + restrictionHours * 3600000,
                              ).toISOString(),
                      },
                      { signal, if_match: current.etag },
                    );
                },
                "Moderation settings saved.",
              );
            }}
            resolveReport={(id) => {
              void action(
                `resolve-report:${id}`,
                async (client, signal) => {
                  const current = await client.getReport(id, { signal });
                  await client.resolveReport(id, {
                    signal,
                    if_match: current.etag,
                  });
                },
                "Report resolved.",
              );
            }}
            removeReportedMessage={(report) => {
              void action(
                `remove:${report.message_id}`,
                async (client, signal) => {
                  const current = await client.getMessage(
                    report.conversation_id,
                    report.message_id,
                    { signal },
                  );
                  await client.removeMessage(
                    report.conversation_id,
                    report.message_id,
                    { signal, if_match: current.etag },
                  );
                },
                "Message removed and kept recoverable.",
              );
            }}
            restoreMessage={(message) => {
              void action(
                `restore:${message.id}`,
                async (client, signal) => {
                  const current = await client.getMessage(
                    message.conversation_id,
                    message.id,
                    { signal },
                  );
                  await client.restoreMessage(
                    message.conversation_id,
                    message.id,
                    { signal, if_match: current.etag },
                  );
                },
                "Message restored.",
              );
            }}
          />
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
