import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import { activePerson, notFound, policyFailure } from "../domain/access";
import { capabilityCheck } from "../domain/capabilities";
import { invalidInput, resolveSettings } from "../domain/settings";
import {
  assertRequestActive,
  capabilityDenied,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import {
  configurationKey,
  configurationSnapshot,
  conversationVersionKeys,
  stageConfigurationChange,
} from "./configuration-mutation";
import {
  compare,
  page,
  requireConversationManagement,
} from "./conversation-structure";
import {
  messageKey,
  messageRow,
  projectMessage,
  readableConversation,
} from "./message-projections";
import {
  messageRemovalCommand,
  messageSendCommand,
} from "./message-transitions";
import type { MemoryCommsState } from "./model";
import {
  assertPendingSchedule,
  requireScheduleAuthor,
  scheduleKey,
  scheduleSendInput,
  type OperationalResources,
} from "./operational-resources";
import { invalidMemoryState } from "./snapshot";
import type { MemoryExecution, MemoryPublication } from "./store-types";

export type OperationalFamily = Pick<
  CommsClient,
  | "getPresence"
  | "heartbeatPresence"
  | "sendTyping"
  | "reportMessage"
  | "listReports"
  | "getReport"
  | "resolveReport"
  | "removeMessage"
  | "restoreMessage"
  | "listRemovedMessages"
  | "setPostingRestrictions"
  | "listSchedules"
  | "getSchedule"
  | "createSchedule"
  | "updateSchedule"
  | "sendScheduleNow"
  | "cancelSchedule"
  | "listAdmissions"
  | "getAdmission"
  | "invitePerson"
  | "decideAdmission"
  | "submitJoinRequest"
>;

const reportKey = (id: string) => `report:${id}`;
const admissionKey = (id: string) => `admission:${id}`;
function conflict(): never {
  return policyFailure({
    status: 409,
    body: { detail: { code: "comms_conflict", message: "Resource changed" } },
  });
}

function timePage<
  T extends { id: string; created_at: string; updated_at: string },
>(items: T[], request: C.TimeListRequest = {}): C.Page<T> {
  const parsed = S.timeListRequestSchema.safeParse(request);
  if (!parsed.success) return invalidInput();
  const { sort_by, sort_order } = parsed.data;
  return page(
    items.sort(
      (a, b) =>
        (compare(a[sort_by], b[sort_by]) || compare(a.id, b.id)) *
        (sort_order === "asc" ? 1 : -1),
    ),
    parsed.data,
  );
}

function scopeFor(
  world: Readonly<MemoryCommsState>,
  id: string,
): C.SettingsScope {
  return world.conversations[id].kind === "channel"
    ? { kind: "channel", id }
    : { kind: "workspace" };
}
function requireCapability(
  binding: MemoryClientBinding,
  world: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  id: string,
  capability: "moderate" | "deleteOthersMessages",
) {
  readableConversation(world, context, id);
  requireAvailable(
    binding,
    context,
    { scope: scopeFor(world, id), capability },
    capabilityCheck(world, context, id).capabilities[capability],
  );
}
/** Only real current recipients; never cache rights with availability objects. */
function managerPublications(
  world: Readonly<MemoryCommsState>,
  id: string,
  capability: "moderate" | "manageChannel",
): MemoryPublication[] {
  return Object.values(world.people)
    .filter((person) => person.active && person.org_id === world.org_id)
    .filter((person) => {
      const check = capabilityCheck(
        world,
        { org_id: world.org_id, user_id: person.user_id },
        id,
      );
      return (
        check.conversation_level !== "none" &&
        check.capabilities[capability].allowed
      );
    })
    .map((person) => ({
      recipient_ids: [person.user_id],
      event: {
        private: true,
        topic: `org:${world.org_id}:user:${person.user_id}`,
        event: "structure",
        payload: {},
      },
    }));
}

function admissionRow(
  world: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  id: string,
) {
  const row = world.admissions[id];
  if (
    !row ||
    row.org_id !== context.org_id ||
    row.conversation_id !== conversationId
  )
    return notFound();
  return row;
}
function stageAdmission(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  conversationId: string,
  userId: string,
  kind: C.Admission["kind"],
): C.Admission {
  const timestamp = new Date(execution.now).toISOString();
  const row: C.Admission = {
    id: execution.uuid(),
    org_id: execution.context.org_id,
    conversation_id: conversationId,
    user_id: userId,
    kind,
    status: "pending",
    created_at: timestamp,
    updated_at: timestamp,
    resolved_at: null,
  };
  if (draft.admissions[row.id]) return invalidMemoryState();
  draft.admissions[row.id] = row;
  return row;
}
function pendingAdmission(
  world: Readonly<MemoryCommsState>,
  conversationId: string,
  userId: string,
) {
  return Object.values(world.admissions).find(
    (row) =>
      row.org_id === world.org_id &&
      row.conversation_id === conversationId &&
      row.user_id === userId &&
      row.status === "pending",
  );
}

export function createOperationalFamily(
  binding: MemoryClientBinding,
  resources: OperationalResources,
): OperationalFamily {
  const { handle } = binding;
  const dependencies = resources.sendDependenciesFor(handle);
  if (dependencies.authority !== binding.authority) invalidMemoryState();
  function active(options?: C.RequestOptions) {
    resources.sendDependenciesFor(handle);
    assertRequestActive(options);
  }
  function report(
    world: Readonly<MemoryCommsState>,
    context: C.CommsContext,
    id: string,
  ) {
    const row = world.reports[id];
    if (!row || row.org_id !== context.org_id) return notFound();
    requireCapability(binding, world, context, row.conversation_id, "moderate");
    return row;
  }
  function manageAdmission(
    world: Readonly<MemoryCommsState>,
    context: C.CommsContext,
    id: string,
  ) {
    requireConversationManagement(binding, world, context, id);
    if (world.conversations[id].kind !== "channel") invalidInput();
  }
  async function remove(
    conversationId: string,
    messageId: string,
    action: "delete" | "restore",
    options: C.ConditionalOptions,
  ) {
    active(options);
    const recipe = messageRemovalCommand({
      conversation_id: conversationId,
      message_id: messageId,
      action,
      options,
    });
    const result = await handle.command({
      ...recipe,
      authorize(world, execution, prepared) {
        active();
        recipe.authorize(world, execution, prepared);
        requireCapability(
          binding,
          world,
          execution.context,
          conversationId,
          "deleteOthersMessages",
        );
      },
    });
    return { data: result.value, etag: result.versions[messageKey(messageId)] };
  }

  return {
    async getPresence(request, options) {
      return resources.presenceFor(handle, request, options);
    },
    heartbeatPresence(request, options) {
      return resources.heartbeat(handle, request, options);
    },
    sendTyping(conversationId, options) {
      return resources.typeIn(handle, conversationId, options);
    },

    async reportMessage(conversationId, messageId, request, options) {
      active(options);
      const parsed = S.reportRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          active();
          messageRow(world, execution.context, conversationId, messageId);
        },
        apply(draft, execution) {
          const timestamp = new Date(execution.now).toISOString();
          const row: C.Report = {
            id: execution.uuid(),
            org_id: execution.context.org_id,
            conversation_id: conversationId,
            message_id: messageId,
            reporter_id: execution.context.user_id,
            reason: parsed.data.reason,
            status: "open",
            created_at: timestamp,
            updated_at: timestamp,
          };
          if (draft.reports[row.id]) return invalidMemoryState();
          draft.reports[row.id] = row;
          return {
            kind: "commit",
            value: undefined,
            version_keys: [reportKey(row.id)],
            publications: managerPublications(
              draft,
              conversationId,
              "moderate",
            ),
          };
        },
      });
    },
    async listReports(request, options) {
      active(options);
      return handle.read((world, context) => {
        const visible = Object.keys(world.conversations).filter((id) => {
          const check = capabilityCheck(world, context, id);
          return (
            check.conversation_level !== "none" &&
            check.capabilities.moderate.allowed
          );
        });
        if (!visible.length) capabilityDenied();
        for (const id of visible)
          requireCapability(binding, world, context, id, "moderate");
        return timePage(
          Object.values(world.reports).filter(
            (row) =>
              row.org_id === context.org_id &&
              visible.includes(row.conversation_id),
          ),
          request,
        );
      });
    },
    async getReport(id, options) {
      active(options);
      return handle.read((world, context) => ({
        data: report(world, context, id),
        etag: handle.version(reportKey(id)),
      }));
    },
    async resolveReport(id, options) {
      active(options);
      const key = reportKey(id);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          active();
          report(world, execution.context, id);
        },
        apply(draft, execution) {
          const row = draft.reports[id];
          if (row.status === "resolved")
            return { kind: "unchanged", value: row, version_keys: [key] };
          row.status = "resolved";
          row.updated_at = new Date(execution.now).toISOString();
          return {
            kind: "commit",
            value: row,
            version_keys: [key],
            publications: managerPublications(
              draft,
              row.conversation_id,
              "moderate",
            ),
          };
        },
      });
      return result.value;
    },
    async removeMessage(conversationId, messageId, options) {
      const result = await remove(conversationId, messageId, "delete", options);
      if (result.data.state !== "deleted") return invalidMemoryState();
      return { data: result.data, etag: result.etag };
    },
    async restoreMessage(conversationId, messageId, options) {
      const result = await remove(
        conversationId,
        messageId,
        "restore",
        options,
      );
      if (result.data.state !== "live") return invalidMemoryState();
      return { data: result.data, etag: result.etag };
    },
    async listRemovedMessages(conversationId, request = {}, options) {
      active(options);
      const parsed = S.timeListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        requireCapability(
          binding,
          world,
          context,
          conversationId,
          "deleteOthersMessages",
        );
        const rows = Object.values(world.messages).filter(
          (row) =>
            row.org_id === context.org_id &&
            row.conversation_id === conversationId &&
            row.deleted_at,
        );
        const sorted = rows.sort((a, b) => {
          const left =
            parsed.data.sort_by === "updated_at" ? a.deleted_at! : a.created_at;
          const right =
            parsed.data.sort_by === "updated_at" ? b.deleted_at! : b.created_at;
          return (
            (compare(left, right) || compare(a.id, b.id)) *
            (parsed.data.sort_order === "asc" ? 1 : -1)
          );
        });
        const projected = sorted.map((row) => {
          const message = projectMessage(
            world,
            context,
            conversationId,
            row.id,
          );
          if (message.state !== "deleted") return invalidMemoryState();
          return message;
        });
        return page(projected, parsed.data);
      });
    },
    async setPostingRestrictions(conversationId, request, options) {
      active(options);
      const parsed = S.restrictionRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const scope = { kind: "channel", id: conversationId } as const;
      const key = configurationKey(scope);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          active();
          requireCapability(
            binding,
            world,
            execution.context,
            conversationId,
            "moderate",
          );
          if (world.conversations[conversationId].kind !== "channel")
            invalidInput();
          for (const user_id of parsed.data.user_ids)
            activePerson(world, { ...execution.context, user_id });
        },
        apply(draft, execution) {
          const next = configurationSnapshot(draft, scope);
          next.settings = {
            ...next.settings,
            restricted_person_ids: parsed.data.user_ids,
            restriction_until: parsed.data.until,
          };
          const staged = stageConfigurationChange(
            draft,
            execution,
            scope,
            next,
          );
          return {
            kind: "commit",
            value: resolveSettings(draft, scope),
            version_keys: staged.version_keys,
            publications: staged.publications,
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },

    async listSchedules(request, options) {
      active(options);
      return handle.read((world, context) =>
        timePage(
          Object.values(world.schedules).filter(
            (row) =>
              row.org_id === context.org_id &&
              row.author_id === context.user_id,
          ),
          request,
        ),
      );
    },
    async getSchedule(id, options) {
      active(options);
      return handle.read((world, context) => ({
        data: requireScheduleAuthor(world, context, id),
        etag: handle.version(scheduleKey(id)),
      }));
    },
    async createSchedule(request, options) {
      active(options);
      const parsed = S.scheduleRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const recipe = messageSendCommand(
        scheduleSendInput(parsed.data),
        dependencies,
      );
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          active();
          if (Date.parse(parsed.data.send_at) <= execution.now) invalidInput();
          recipe.authorize(world, execution, undefined);
        },
        apply(draft, execution) {
          const timestamp = new Date(execution.now).toISOString();
          const row: C.Schedule = {
            id: execution.uuid(),
            org_id: execution.context.org_id,
            author_id: execution.context.user_id,
            request: parsed.data,
            status: "pending",
            message_id: null,
            failure_code: null,
            created_at: timestamp,
            updated_at: timestamp,
          };
          if (draft.schedules[row.id]) return invalidMemoryState();
          draft.schedules[row.id] = row;
          return {
            kind: "commit",
            value: row,
            version_keys: [scheduleKey(row.id)],
            publications: [],
          };
        },
      });
      return {
        data: result.value,
        etag: result.versions[scheduleKey(result.value.id)],
      };
    },
    async updateSchedule(id, request, options) {
      active(options);
      const parsed = S.scheduleRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = scheduleKey(id);
      const recipe = messageSendCommand(
        scheduleSendInput(parsed.data),
        dependencies,
      );
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          active();
          assertPendingSchedule(
            requireScheduleAuthor(world, execution.context, id),
          );
          if (Date.parse(parsed.data.send_at) <= execution.now) invalidInput();
          recipe.authorize(world, execution, undefined);
        },
        apply(draft, execution) {
          const row = {
            ...draft.schedules[id],
            request: parsed.data,
            updated_at: new Date(execution.now).toISOString(),
          };
          draft.schedules[id] = row;
          return {
            kind: "commit",
            value: row,
            version_keys: [key],
            publications: [],
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    sendScheduleNow(id, options) {
      return resources.dispatch(handle, id, options);
    },
    async cancelSchedule(id, options) {
      active(options);
      const key = scheduleKey(id);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          active();
          assertPendingSchedule(
            requireScheduleAuthor(world, execution.context, id),
          );
        },
        apply(draft, execution) {
          const row: C.Schedule = {
            ...draft.schedules[id],
            status: "cancelled",
            updated_at: new Date(execution.now).toISOString(),
          };
          draft.schedules[id] = row;
          return {
            kind: "commit",
            value: row,
            version_keys: [key],
            publications: [],
          };
        },
      });
      return result.value;
    },

    async listAdmissions(conversationId, request, options) {
      active(options);
      return handle.read((world, context) => {
        manageAdmission(world, context, conversationId);
        return timePage(
          Object.values(world.admissions).filter(
            (row) =>
              row.org_id === context.org_id &&
              row.conversation_id === conversationId,
          ),
          request,
        );
      });
    },
    async getAdmission(conversationId, id, options) {
      active(options);
      return handle.read((world, context) => {
        manageAdmission(world, context, conversationId);
        return {
          data: admissionRow(world, context, conversationId, id),
          etag: handle.version(admissionKey(id)),
        };
      });
    },
    async invitePerson(conversationId, request, options) {
      active(options);
      const parsed = S.invitationRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          active();
          manageAdmission(world, execution.context, conversationId);
          activePerson(world, {
            ...execution.context,
            user_id: parsed.data.user_id,
          });
          if (
            world.members[conversationId]?.[parsed.data.user_id] ||
            world.conversations[conversationId].archived_at ||
            pendingAdmission(world, conversationId, parsed.data.user_id)
          )
            conflict();
        },
        apply(draft, execution) {
          const row = stageAdmission(
            draft,
            execution,
            conversationId,
            parsed.data.user_id,
            "invitation",
          );
          return {
            kind: "commit",
            value: row,
            version_keys: [admissionKey(row.id)],
            publications: managerPublications(
              draft,
              conversationId,
              "manageChannel",
            ),
          };
        },
      });
      return {
        data: result.value,
        etag: result.versions[admissionKey(result.value.id)],
      };
    },
    async decideAdmission(conversationId, id, request, options) {
      active(options);
      const parsed = S.admissionDecisionRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = admissionKey(id);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          active();
          manageAdmission(world, execution.context, conversationId);
          admissionRow(world, execution.context, conversationId, id);
        },
        apply(draft, execution) {
          const row = admissionRow(
            draft,
            execution.context,
            conversationId,
            id,
          );
          if (row.status !== "pending") conflict();
          if (parsed.data.decision === "accept") {
            activePerson(draft, { ...execution.context, user_id: row.user_id });
            if (draft.conversations[conversationId].archived_at) conflict();
            const settings = resolveSettings(draft, {
              kind: "channel",
              id: conversationId,
            }).effective;
            if (row.kind === "request" && settings.join_rule !== "request")
              conflict();
            if (!draft.members[conversationId][row.user_id]) {
              draft.members[conversationId][row.user_id] = {
                user_id: row.user_id,
                member_role: "member",
                joined_at: new Date(execution.now).toISOString(),
              };
            }
          }
          const timestamp = new Date(execution.now).toISOString();
          row.status =
            parsed.data.decision === "accept" ? "accepted" : "declined";
          row.updated_at = timestamp;
          row.resolved_at = timestamp;
          const publications = managerPublications(
            draft,
            conversationId,
            "manageChannel",
          );
          const accepted = row.status === "accepted";
          if (accepted) {
            draft.conversations[conversationId].updated_at = timestamp;
            publications.push({
              recipient_ids: [row.user_id],
              event: {
                private: true,
                topic: `org:${draft.org_id}:user:${row.user_id}`,
                event: "membership",
                payload: { conversation_id: conversationId },
              },
            });
          }
          return {
            kind: "commit",
            value: row,
            version_keys: [
              key,
              ...(accepted
                ? conversationVersionKeys(draft, [conversationId])
                : []),
            ],
            publications,
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async submitJoinRequest(request, options) {
      active(options);
      const parsed = S.joinRequestSubmissionSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const id = parsed.data.conversation_id;
      await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          active();
          activePerson(world, execution.context);
        },
        apply(draft, execution) {
          const row = draft.conversations[id];
          if (
            !row ||
            row.org_id !== execution.context.org_id ||
            row.kind !== "channel" ||
            // Like the API, only private (members-scope) channels take requests.
            row.scope !== "members" ||
            row.archived_at ||
            draft.members[id]?.[execution.context.user_id] ||
            pendingAdmission(draft, id, execution.context.user_id) ||
            resolveSettings(draft, { kind: "channel", id }).effective
              .join_rule !== "request"
          )
            return { kind: "unchanged", value: undefined, version_keys: [] };
          const admission = stageAdmission(
            draft,
            execution,
            id,
            execution.context.user_id,
            "request",
          );
          return {
            kind: "commit",
            value: undefined,
            version_keys: [admissionKey(admission.id)],
            publications: managerPublications(draft, id, "manageChannel"),
          };
        },
      });
    },
  };
}
