import type { MemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import * as S from "../../../src/components/systems/comms/contract/schemas";
import type * as C from "../../../src/components/systems/comms/contract/types";

/** One fixture reply; the live helper adds ETag and private no-store headers. */
export type ToolReply = {
  status: number;
  json?: unknown;
  etag?: string;
  location?: string;
  bytes?: { body: Buffer; type: string; filename: string };
};

type Tool = {
  client: MemoryCommsRuntime["client"];
  method: string;
  path: string;
  url: URL;
  body: () => unknown;
  ifMatch: string | undefined;
};

const page = (url: URL) =>
  S.timeListRequestSchema.parse({
    limit: Number(url.searchParams.get("limit") ?? 25),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
const versioned = (result: { data: unknown; etag: string }): ToolReply => ({
  status: 200,
  json: result.data,
  etag: result.etag,
});
const created = (
  result: { data: { id: string }; etag: string },
  collection: string,
): ToolReply => ({
  status: 201,
  json: result.data,
  etag: result.etag,
  location: `/api/comms/${collection}/${result.data.id}`,
});
function settingsScope(parts: string[]): {
  scope: C.SettingsScope;
  rest: string[];
} {
  return parts[0] === "workspace"
    ? { scope: { kind: "workspace" }, rest: parts.slice(1) }
    : {
        scope: { kind: parts[0] as "category" | "channel", id: parts[1] },
        rest: parts.slice(2),
      };
}
/** Strip the fresh-password proof the live client sends in the body. */
function proof(input: unknown) {
  const { password, ...request } = input as Record<string, unknown> & {
    password?: string;
  };
  return { request, password: password ?? "" };
}

/**
 * Serves the live tool routes (templates, history, admissions, schedules,
 * retention, export, moderation, locks and capabilities) from the seeded
 * fixture world. Returns undefined for a route that is not a tool route.
 */
export async function commsToolRoute({
  client,
  method,
  path,
  url,
  body,
  ifMatch,
}: Tool): Promise<ToolReply | undefined> {
  const condition = { if_match: ifMatch ?? "" };
  const parts = path.split("/").slice(1);
  const [root] = parts;
  if (root === "templates") {
    const [, id, action] = parts;
    if (!id)
      return method === "GET"
        ? { status: 200, json: await client.listTemplates(page(url)) }
        : created(
            await client.createTemplate(body() as C.TemplateImport),
            "templates",
          );
    if (action === "application-preview")
      return versioned(
        await client.previewTemplateApply(id, body() as C.TemplateApplyRequest),
      );
    if (action === "applications")
      return {
        status: 200,
        json: await client.applyTemplate(
          id,
          body() as C.TemplateApplyRequest,
          condition,
        ),
      };
    return versioned(
      method === "GET"
        ? await client.getTemplate(id)
        : await client.saveTemplate(id, body() as C.TemplateImport, condition),
    );
  }
  if (root === "settings") {
    const { scope, rest } = settingsScope(parts.slice(1));
    const [action, historyId] = rest;
    if (action === "history")
      return historyId
        ? {
            status: 200,
            json: await client.getConfigurationHistory(scope, historyId),
          }
        : {
            status: 200,
            json: await client.listConfigurationHistory(scope, page(url)),
          };
    if (action === "restoration-preview") {
      const { request, password } = proof(body());
      return versioned(
        await client.previewConfigurationRestore(
          scope,
          String(request.history_id),
          { ...condition, password },
        ),
      );
    }
    if (action === "restoration") {
      const { request, password } = proof(body());
      return versioned(
        await client.restoreConfiguration(
          scope,
          request as C.ConfigurationRestoreRequest,
          { ...condition, password },
        ),
      );
    }
    if (action === "reset")
      return versioned(
        await client.resetSettings(scope, body() as C.SettingsReset, condition),
      );
    if (action === "locks" && method === "PUT")
      return versioned(
        await client.setSettingsLocks(body() as C.SettingsLocks, condition),
      );
    if (action === "capabilities" && method === "PUT")
      return versioned(
        await client.setCapabilityConfiguration(
          body() as C.CapabilityConfiguration,
          condition,
        ),
      );
    if (action === "capability-locks" && method === "PUT")
      return versioned(
        await client.setCapabilityLocks(body() as C.CapabilityLocks, condition),
      );
    return undefined;
  }
  if (root === "scheduled-messages") {
    const [, id, action] = parts;
    if (!id)
      return method === "GET"
        ? { status: 200, json: await client.listSchedules(page(url)) }
        : created(
            await client.createSchedule(body() as C.ScheduleRequest),
            "scheduled-messages",
          );
    if (action === "send")
      return { status: 200, json: await client.sendScheduleNow(id, condition) };
    if (action === "cancellation")
      return { status: 200, json: await client.cancelSchedule(id, condition) };
    return versioned(
      method === "GET"
        ? await client.getSchedule(id)
        : await client.updateSchedule(
            id,
            body() as C.ScheduleRequest,
            condition,
          ),
    );
  }
  if (root === "retention") {
    if (parts[1] === "preview") {
      const { request, password } = proof(body());
      return {
        status: 200,
        json: await client.previewRetention(request as C.RetentionPolicy, {
          ...condition,
          password,
        }),
      };
    }
    if (method === "PUT") {
      const { request, password } = proof(body());
      return versioned(
        await client.updateRetention(request as C.RetentionRequest, {
          ...condition,
          password,
        }),
      );
    }
    const channel = url.searchParams.get("channel_id");
    return versioned(
      await client.getRetention(
        channel ? { kind: "channel", id: channel } : { kind: "workspace" },
      ),
    );
  }
  if (root === "exports") {
    const [, id, action] = parts;
    if (!id) {
      if (method === "GET")
        return { status: 200, json: await client.listExports(page(url)) };
      const { request, password } = proof(body());
      const job = await client.startExport(
        request as C.ExportRequest,
        password ? { password } : {},
      );
      return {
        status: 201,
        json: job,
        location: `/api/comms/exports/${job.id}`,
      };
    }
    if (action === "content") {
      const file = await client.downloadExport(id);
      return {
        status: 200,
        bytes: {
          body: Buffer.from(await file.bytes.arrayBuffer()),
          type: file.media_type,
          filename: file.filename,
        },
      };
    }
    return { status: 200, json: await client.getExport(id) };
  }
  if (root === "reports") {
    const [, id, action] = parts;
    if (!id) return { status: 200, json: await client.listReports(page(url)) };
    if (action === "resolution")
      return { status: 200, json: await client.resolveReport(id, condition) };
    return versioned(await client.getReport(id));
  }
  if (root === "conversations" && parts[1]) {
    const conversationId = parts[1];
    const tail = parts.slice(2);
    if (tail[0] === "members" && tail[1] && method === "PUT")
      return {
        status: 200,
        json: await client.setMemberRole(
          conversationId,
          tail[1],
          body() as C.MemberRoleRequest,
          condition,
        ),
      };
    if (tail[0] === "members" && tail[1] && method === "DELETE") {
      await client.removeMember(conversationId, tail[1], condition);
      return { status: 204 };
    }
    if (tail[0] === "archive" || tail[0] === "restore")
      return versioned(
        tail[0] === "archive"
          ? await client.archiveConversation(conversationId, condition)
          : await client.restoreConversation(conversationId, condition),
      );
    if (tail[0] === "duplicates")
      return created(
        await client.duplicateChannel(
          conversationId,
          body() as C.DuplicateChannelRequest,
          condition,
        ),
        "conversations",
      );
    if (tail[0] === "restrictions")
      return versioned(
        await client.setPostingRestrictions(
          conversationId,
          body() as C.RestrictionRequest,
          condition,
        ),
      );
    if (tail[0] === "capabilities" && tail[1])
      return {
        status: 200,
        json: await client.checkPerson(conversationId, tail[1]),
      };
    if (tail[0] === "messages" && tail[1] && tail[2]) {
      const messageId = tail[1];
      if (tail[2] === "removal")
        return versioned(
          await client.removeMessage(conversationId, messageId, condition),
        );
      if (tail[2] === "restoration")
        return versioned(
          await client.restoreMessage(conversationId, messageId, condition),
        );
      if (tail[2] === "reports") {
        await client.reportMessage(
          conversationId,
          messageId,
          body() as C.ReportRequest,
        );
        return { status: 204 };
      }
      if (tail[2] === "revisions")
        return {
          status: 200,
          json: await client.listMessageRevisions(
            conversationId,
            messageId,
            page(url),
          ),
        };
    }
  }
  return undefined;
}
