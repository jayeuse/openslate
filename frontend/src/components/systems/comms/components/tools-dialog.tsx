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
import { ConfigurationFrame } from "./configuration-frame";
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
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { complete } from "../state/workspace-view";
import {
  messageFromCommsError,
  useCommsCommands,
  useCommsRead,
} from "../state/runtime";

export type CommsToolsView =
  | "management"
  | "templates"
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
const titles: Record<CommsToolsView, string> = {
  management: "Bulk channel changes",
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
  return props.view === "management" || props.view === "templates" ? (
    <ManagementTools {...props} view={props.view} />
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
const sampleMarker = "CONFIRM LOCAL SAMPLE";

function LifecycleTools({
  view,
  channelId,
  threadId,
  messageId,
  opener,
  onClose,
}: CommsToolsDialogProps) {
  const workspace = useCommsWorkspaceView();
  const { run, isPending } = useCommsCommands();
  const { channels, people, messages, threads } = workspace;
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
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [days, setDays] = useState(0);
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
  const [preview, setPreview] = useState(false);
  const [restrictedId, setRestrictedId] = useState("");
  const [restrictionHours, setRestrictionHours] = useState(24);
  useEffect(() => {
    if (dirty || !resource.data?.retention) return;
    setDays(resource.data.retention.data.effective.message_days);
    setInheritRetention(
      resource.data.retention.data.policy.message_days === null,
    );
  }, [resource.data?.retention, dirty]);
  async function action(
    key: string,
    operation: Parameters<typeof run<void>>[1],
    success?: string,
  ) {
    setError("");
    setStatus("");
    try {
      await run(key, operation);
      if (success) setStatus(success);
      resource.reload();
      return true;
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The change could not be completed. Your draft is still here.",
        ),
      );
      return false;
    }
  }
  async function save() {
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
          send_at: new Date(sendAt).toISOString(),
        };
        const accepted = current
          ? await client.updateSchedule(current.data.id, request, {
              ...options,
              if_match: current.etag,
            })
          : await client.createSchedule(request, options);
        createdSchedule.current = accepted.data.id;
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
      title={titles[view]}
      description={
        view === "moderation"
          ? "Review reports, limit posting, and restore removed messages."
          : view === "retention"
            ? "Preview and save retention for local sample data."
            : view === "history"
              ? "Preview a saved change before restoring its earlier values."
              : undefined
      }
      opener={opener}
      onClose={onClose}
      dirty={dirty}
      disabled={isPending()}
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
          <Toggle
            label="Confirm sample operation — local example data only; no account password required."
            checked={sampleConfirmed}
            onCheckedChange={setSampleConfirmed}
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
              disabled={!sampleConfirmed || isPending()}
              onPreview={(entry) => {
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
                        password: sampleMarker,
                      },
                    );
                    setRestore({ entry, preview });
                  },
                );
              }}
            />
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
                    disabled={!sampleConfirmed || isPending()}
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
                              password: sampleMarker,
                            },
                          );
                          setRestore(undefined);
                        },
                        "Configuration restored.",
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
          </>
        )}
        {view === "retention" && (
          <>
            <Choice
              label="Retention scope"
              value={retentionTarget}
              onChange={(event) => {
                setRetentionTarget(event.target.value);
                setRetentionPreview(undefined);
                setDirty(false);
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
            <RetentionPreviewFields
              days={days}
              setDays={(value) => {
                setDays(value);
                setDirty(true);
                setRetentionPreview(undefined);
              }}
              preview={retentionPreview?.value}
              disabled={
                !sampleConfirmed || isPending() || !resource.data?.retention
              }
              inherited={retentionTarget !== "workspace" && inheritRetention}
              onInherit={
                retentionTarget === "workspace"
                  ? undefined
                  : () => {
                      setInheritRetention(!inheritRetention);
                      setDirty(true);
                      setRetentionPreview(undefined);
                    }
              }
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
                          file_days: current.data.effective.file_days,
                        }
                      : {
                          scope: retentionScope,
                          message_days: inheritRetention ? null : days,
                          file_days: current.data.policy.file_days,
                        };
                  const value = await client.previewRetention(policy, {
                    signal,
                    if_match: current.etag,
                    password: sampleMarker,
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
                        password: sampleMarker,
                      },
                    );
                    setRetentionPreview(undefined);
                    setDirty(false);
                  },
                  "Retention policy saved.",
                );
              }}
            />
          </>
        )}
        {view === "outbox" && resource.data && (
          <OutboxFields
            schedules={resource.data.schedules}
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
            updateModeration={(operation) => {
              void action(
                `moderation:${moderationChannel}`,
                async (client, signal) => {
                  const scope = {
                    kind: "channel",
                    id: moderationChannel,
                  } as const;
                  const current = await client.getSettings(scope, { signal });
                  if (operation === "lock")
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
