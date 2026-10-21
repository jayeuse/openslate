import { ApiContractError, ApiError } from "@/lib/api";
import { currentOrganizationId } from "@/lib/organization-context";
import { listNotifications } from "../../shared/adapters/notifications-api";
import type { CommsClient } from "../contract/client";
import * as C from "../contract/schemas";
import type * as T from "../contract/types";
import type {
  HttpHeartbeatRequest,
  HttpHeartbeatResponse,
} from "./presence-contract";
import * as messages from "./message-api";
import * as structure from "./structure-api";
import * as preferences from "./preferences-api";
import * as settings from "./settings-api";
import * as threads from "./threads-api";
import * as presence from "./presence-api";
import { search } from "./search-api";
import {
  listDirectCandidates,
  type HttpDirectCandidateRequest,
  type HttpDirectCandidates,
} from "./direct-candidates-api";

export type ReadyHttpCommsClient = Omit<
  CommsClient,
  "events" | "listDirectCandidates" | "heartbeatPresence"
> & {
  heartbeatPresence(
    request: HttpHeartbeatRequest,
    options?: T.RequestOptions,
  ): Promise<HttpHeartbeatResponse>;
  listDirectCandidates(
    request: HttpDirectCandidateRequest,
    options?: T.RequestOptions,
  ): Promise<HttpDirectCandidates>;
  removeReportedMessage(
    id: string,
    options: T.ConditionalOptions,
  ): Promise<T.Versioned<T.Report>>;
  restoreReportedMessage(
    id: string,
    options: T.ConditionalOptions,
  ): Promise<T.Versioned<T.Report>>;
};

async function activity(
  context: T.CommsContext,
  input: T.TimeListRequest = {},
  options: T.RequestOptions = {},
): Promise<T.Page<T.CommsNotification>> {
  const request = C.timeListRequestSchema.parse(input);
  const rows: T.CommsNotification[] = [];
  let offset = 0;
  for (;;) {
    if (currentOrganizationId() !== context.org_id)
      throw new DOMException("Organization changed", "AbortError");
    const page = await listNotifications(
      { limit: 100, offset },
      options.signal,
    );
    if (currentOrganizationId() !== context.org_id)
      throw new DOMException("Organization changed", "AbortError");
    for (const item of page.items)
      if (item.subjectType === "comms_message")
        rows.push(
          C.notificationSchema.parse({
            id: item.id,
            org_id: item.orgId,
            subject_type: item.subjectType,
            subject_id: item.subjectId,
            kind: item.kind,
            conversation_id: item.conversationId,
            message_id: item.messageId,
            status: item.status,
            scheduled_for: item.scheduledFor,
            created_at: item.createdAt,
            read_at: item.readAt,
          }),
        );
    if (!page.pagination.hasMore) break;
    offset += page.items.length;
  }
  rows.sort(
    (a, b) =>
      (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) *
      (request.sort_order === "asc" ? 1 : -1),
  );
  const items = rows.slice(request.offset, request.offset + request.limit);
  return {
    items,
    pagination: {
      limit: request.limit,
      offset: request.offset,
      count: items.length,
      total: rows.length,
      has_more: request.offset + items.length < rows.length,
    },
  };
}

function clientError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError")
    return Object.assign(new Error("OpenComms operation cancelled"), {
      kind: "cancelled" as const,
    });
  if (error instanceof ApiContractError)
    return Object.assign(error, { kind: "invalid_response" as const });
  if (error instanceof ApiError) {
    const failure = C.commsFailureSchema.safeParse({
      status: error.status,
      body: { detail: error.details },
      ...(error.status === 429 && error.retryAfter !== undefined
        ? { retry_after_seconds: error.retryAfter }
        : {}),
    });
    // Keep genuine shared/auth error shapes rather than inventing an HTTP body.
    return failure.success
      ? Object.assign(error, { kind: "http" as const, failure: failure.data })
      : error;
  }
  if (error instanceof TypeError)
    return Object.assign(new Error("The request could not reach the server"), {
      kind: "network" as const,
    });
  return error;
}

/** Bind only real ready transports. Activity/candidate projections and events are composed by the owner. */
export function createReadyHttpCommsClient(
  input: T.CommsContext,
  lifetime: AbortSignal,
): ReadyHttpCommsClient {
  const context = Object.freeze(C.commsContextSchema.parse(input));
  function bind<Args extends unknown[], Result>(
    operation: (context: T.CommsContext, ...args: Args) => Promise<Result>,
    optionsAt: number,
  ) {
    return async (...args: Args): Promise<Result> => {
      const options = args[optionsAt] as T.RequestOptions | undefined;
      const signal = options?.signal
        ? AbortSignal.any([lifetime, options.signal])
        : lifetime;
      const bound = [...args] as Args;
      bound[optionsAt] = { ...options, signal } as Args[number];
      try {
        signal.throwIfAborted();
        const result = await operation(context, ...bound);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        throw clientError(
          signal.aborted
            ? new DOMException("Admission retired", "AbortError")
            : error,
        );
      }
    };
  }
  function deferred<Args extends unknown[], Result>(
    load: () => Promise<
      (context: T.CommsContext, ...args: Args) => Promise<Result>
    >,
    optionsAt: number,
  ) {
    return bind(async (context: T.CommsContext, ...args: Args) => {
      const operation = await load();
      (
        args[optionsAt] as T.RequestOptions | undefined
      )?.signal?.throwIfAborted();
      return operation(context, ...args);
    }, optionsAt);
  }
  return Object.freeze({
    context,
    listActivity: bind(activity, 1),
    listDirectCandidates: bind(listDirectCandidates, 1),
    bootstrap: bind(messages.bootstrap, 0),
    listConversations: bind(structure.listConversations, 1),
    getConversation: bind(structure.getConversation, 1),
    listCategories: bind(structure.listCategories, 1),
    getCategory: bind(structure.getCategory, 1),
    createCategory: bind(structure.createCategory, 1),
    updateCategory: bind(structure.updateCategory, 2),
    createChannel: bind(structure.createChannel, 1),
    updateChannel: bind(structure.updateChannel, 2),
    archiveConversation: bind(structure.archiveConversation, 1),
    restoreConversation: bind(structure.restoreConversation, 1),
    findOrCreateDirect: bind(structure.findOrCreateDirect, 1),
    createGroup: bind(structure.createGroup, 1),
    listMembers: bind(structure.listMembers, 2),
    setChannelAccess: bind(structure.setChannelAccess, 2),
    setMemberRole: bind(structure.setMemberRole, 3),
    removeMember: bind(structure.removeMember, 2),
    duplicateChannel: bind(structure.duplicateChannel, 2),
    listDirectBlocks: bind(structure.listDirectBlocks, 1),
    blockDirect: bind(structure.blockDirect, 1),
    unblockDirect: bind(structure.unblockDirect, 1),
    getPersonalPreferences: bind(preferences.getPersonalPreferences, 0),
    setPersonalPreferences: bind(preferences.setPersonalPreferences, 1),
    getMemberPreferences: bind(preferences.getMemberPreferences, 1),
    updateMemberPreferences: bind(preferences.updateMemberPreferences, 2),
    getCategoryPreferences: bind(preferences.getCategoryPreferences, 1),
    setCategoryPreferences: bind(preferences.setCategoryPreferences, 2),
    markRead: bind(messages.markRead, 2),
    getHistory: bind(messages.getHistory, 2),
    getMessage: bind(messages.getMessage, 2),
    getMessageBySequence: bind(messages.getMessageBySequence, 2),
    sendMessage: bind(messages.sendMessage, 2),
    editMessage: bind(messages.editMessage, 3),
    deleteMessage: bind(messages.deleteMessage, 2),
    listMessageRevisions: deferred(
      async () => (await import("./moderation-api")).listMessageRevisions,
      3,
    ),
    getThread: bind(threads.getThread, 2),
    createThread: bind(threads.createThread, 2),
    getReplies: bind(threads.getReplies, 3),
    sendReply: bind(threads.sendReply, 3),
    updateThread: bind(threads.updateThread, 3),
    followThread: bind(threads.followThread, 3),
    listThreads: bind(threads.listThreads, 1),
    addReaction: bind(threads.addReaction, 3),
    removeReaction: bind(threads.removeReaction, 3),
    setPin: bind(threads.setPin, 3),
    listPins: bind(threads.listPins, 2),
    reserveAttachment: deferred(
      async () => (await import("./assets-api")).reserveAttachment,
      2,
    ),
    uploadAttachment: deferred(
      async () => (await import("./assets-api")).uploadAttachment,
      3,
    ),
    downloadAttachment: deferred(
      async () => (await import("./assets-api")).downloadAttachment,
      2,
    ),
    getRecordReference: deferred(
      async () => (await import("./assets-api")).getRecordReference,
      2,
    ),
    listLinkedRecords: deferred(
      async () => (await import("./assets-api")).listLinkedRecords,
      1,
    ),
    getSettings: bind(settings.getSettings, 1),
    updateSettings: bind(settings.updateSettings, 2),
    resetSettings: bind(settings.resetSettings, 2),
    setSettingsLocks: bind(settings.setSettingsLocks, 1),
    getCapabilityConfiguration: bind(settings.getCapabilityConfiguration, 1),
    setCapabilityConfiguration: bind(settings.setCapabilityConfiguration, 1),
    getCapabilityLocks: bind(settings.getCapabilityLocks, 0),
    setCapabilityLocks: bind(settings.setCapabilityLocks, 1),
    getCapabilities: bind(settings.getCapabilities, 1),
    checkPerson: bind(settings.checkPerson, 2),
    getChannelCreationCheck: bind(settings.getChannelCreationCheck, 1),
    getDirectPolicy: bind(settings.getDirectPolicy, 0),
    setDirectPolicy: bind(settings.setDirectPolicy, 1),
    getPresence: bind(presence.getPresence, 1),
    heartbeatPresence: bind(presence.heartbeatPresence, 1),
    sendTyping: bind(presence.sendTyping, 1),
    search: bind(search, 1),
    reportMessage: deferred(
      async () => (await import("./moderation-api")).reportMessage,
      3,
    ),
    listReports: deferred(
      async () => (await import("./moderation-api")).listReports,
      1,
    ),
    getReport: deferred(
      async () => (await import("./moderation-api")).getReport,
      1,
    ),
    resolveReport: deferred(
      async () => (await import("./moderation-api")).resolveReport,
      1,
    ),
    removeReportedMessage: deferred(
      async () => (await import("./moderation-api")).removeReportedMessage,
      1,
    ),
    restoreReportedMessage: deferred(
      async () => (await import("./moderation-api")).restoreReportedMessage,
      1,
    ),
    removeMessage: deferred(
      async () => (await import("./moderation-api")).removeMessage,
      2,
    ),
    restoreMessage: deferred(
      async () => (await import("./moderation-api")).restoreMessage,
      2,
    ),
    listRemovedMessages: deferred(
      async () => (await import("./moderation-api")).listRemovedMessages,
      2,
    ),
    setPostingRestrictions: deferred(
      async () => (await import("./moderation-api")).setPostingRestrictions,
      2,
    ),
    previewPurge: deferred(
      async () => (await import("./moderation-api")).previewPurge,
      1,
    ),
    purgeConversation: deferred(
      async () => (await import("./moderation-api")).purgeConversation,
      2,
    ),
    listSchedules: deferred(
      async () => (await import("./jobs-api")).listSchedules,
      1,
    ),
    getSchedule: deferred(
      async () => (await import("./jobs-api")).getSchedule,
      1,
    ),
    createSchedule: deferred(
      async () => (await import("./jobs-api")).createSchedule,
      1,
    ),
    updateSchedule: deferred(
      async () => (await import("./jobs-api")).updateSchedule,
      2,
    ),
    sendScheduleNow: deferred(
      async () => (await import("./jobs-api")).sendScheduleNow,
      1,
    ),
    cancelSchedule: deferred(
      async () => (await import("./jobs-api")).cancelSchedule,
      1,
    ),
    listExports: deferred(
      async () => (await import("./jobs-api")).listExports,
      1,
    ),
    startExport: deferred(
      async () => (await import("./jobs-api")).startExport,
      1,
    ),
    getExport: deferred(async () => (await import("./jobs-api")).getExport, 1),
    downloadExport: deferred(
      async () => (await import("./jobs-api")).downloadExport,
      1,
    ),
    getRetention: deferred(
      async () => (await import("./retention-api")).getRetention,
      1,
    ),
    previewRetention: deferred(
      async () => (await import("./retention-api")).previewRetention,
      1,
    ),
    updateRetention: deferred(
      async () => (await import("./retention-api")).updateRetention,
      1,
    ),
    listTemplates: deferred(
      async () => (await import("./configuration-api")).listTemplates,
      1,
    ),
    getTemplate: deferred(
      async () => (await import("./configuration-api")).getTemplate,
      1,
    ),
    previewTemplateApply: deferred(
      async () => (await import("./configuration-api")).previewTemplateApply,
      2,
    ),
    saveTemplate: deferred(
      async () => (await import("./configuration-api")).saveTemplate,
      2,
    ),
    createTemplate: deferred(
      async () => (await import("./configuration-api")).createTemplate,
      1,
    ),
    applyTemplate: deferred(
      async () => (await import("./configuration-api")).applyTemplate,
      2,
    ),
    listConfigurationHistory: deferred(
      async () =>
        (await import("./configuration-api")).listConfigurationHistory,
      2,
    ),
    getConfigurationHistory: deferred(
      async () => (await import("./configuration-api")).getConfigurationHistory,
      2,
    ),
    previewConfigurationRestore: deferred(
      async () =>
        (await import("./configuration-api")).previewConfigurationRestore,
      2,
    ),
    restoreConfiguration: deferred(
      async () => (await import("./configuration-api")).restoreConfiguration,
      2,
    ),
    listAdmissions: deferred(
      async () => (await import("./admissions-api")).listAdmissions,
      2,
    ),
    getAdmission: deferred(
      async () => (await import("./admissions-api")).getAdmission,
      2,
    ),
    invitePerson: deferred(
      async () => (await import("./admissions-api")).invitePerson,
      2,
    ),
    decideAdmission: deferred(
      async () => (await import("./admissions-api")).decideAdmission,
      3,
    ),
    submitJoinRequest: deferred(
      async () => (await import("./admissions-api")).submitJoinRequest,
      1,
    ),
  });
}
