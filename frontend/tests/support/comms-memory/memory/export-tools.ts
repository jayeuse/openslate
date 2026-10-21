import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import { notFound, policyFailure } from "../domain/access";
import { invalidInput } from "../domain/settings";
import { capabilityDenied } from "./availability";
import { compare } from "./conversation-structure";
import {
  conversationSettings,
  readableConversation,
} from "./message-projections";
import type { MemoryCommsState } from "./model";
import type { ToolSession } from "./protected-tools";
import { invalidMemoryState } from "./snapshot";

export type ExportTools = Pick<
  CommsClient,
  "listExports" | "startExport" | "getExport" | "downloadExport"
>;
type CommittedExport = {
  job: string;
  private_sources: string[];
  download: C.BinaryDownload;
};
function unavailable(): never {
  return policyFailure({
    status: 503,
    body: { detail: { code: "comms_unavailable", message: "Unavailable" } },
  });
}

/** One resource-lifetime byte root, shared by its currently authorized bindings. */
export function createExportTools() {
  let committed = new Map<string, CommittedExport>();
  return {
    dispose() {
      committed = new Map();
    },
    bind(session: ToolSession): ExportTools {
      const { handle } = session.binding;
      function job(world: Readonly<MemoryCommsState>, id: string) {
        session.admin(world);
        const row = world.exports[id];
        if (!row || row.org_id !== handle.context.org_id) return notFound();
        return row;
      }
      function sources(
        world: Readonly<MemoryCommsState>,
        request: C.ExportRequest,
      ) {
        session.admin(world);
        return request.conversation_ids.map((id) => {
          const row = readableConversation(world, handle.context, id);
          if (!conversationSettings(world, id).allow_export)
            return capabilityDenied();
          return row;
        });
      }
      function selection(
        world: Readonly<MemoryCommsState>,
        request: C.ExportRequest,
      ) {
        const rooms = sources(world, request);
        const ids = new Set(request.conversation_ids);
        const messages = Object.values(world.messages)
          .filter(
            (message) =>
              ids.has(message.conversation_id) &&
              message.deleted_at === null &&
              (!request.after ||
                message.created_at.slice(0, 10) >= request.after) &&
              (!request.before ||
                message.created_at.slice(0, 10) < request.before),
          )
          .sort(
            (a, b) =>
              compare(a.conversation_id, b.conversation_id) ||
              a.seq - b.seq ||
              compare(a.id, b.id),
          );
        const privateSources = rooms
          .filter((row) => row.kind !== "channel" || row.scope === "members")
          .map((row) => row.id)
          .sort();
        const rows: string[][] = [
          [
            "conversation_id",
            "conversation",
            "message_id",
            "sequence",
            "author_id",
            "author",
            "created_at",
            "parent_id",
            "body",
          ],
        ];
        for (const message of messages) {
          const room = world.conversations[message.conversation_id];
          rows.push([
            room.id,
            room.kind === "direct" ? "Direct conversation" : room.name,
            message.id,
            String(message.seq),
            message.author_id,
            world.people[message.author_id].display_name,
            message.created_at,
            message.parent_id ?? "",
            message.body,
          ]);
        }
        return {
          rows,
          privateSources,
          witness: session.describe({
            request,
            privateSources,
            sources: rooms.map((room) => ({
              row: room,
              version: world.resource_versions[`conversation:${room.id}`] ?? 0,
              authority: session.scopeWitness(
                world,
                room.kind === "channel"
                  ? { kind: "channel", id: room.id }
                  : { kind: "workspace" },
              ),
            })),
            messages: messages.map((message) => [
              message.id,
              world.resource_versions[`message:${message.id}`] ?? 0,
            ]),
            rows,
          }),
        };
      }
      return {
        async listExports(request, options) {
          session.active(options);
          return handle.read((world) => {
            session.admin(world);
            return session.timePage(
              Object.values(world.exports).filter(
                (row) => row.org_id === handle.context.org_id,
              ),
              request,
            );
          });
        },
        async getExport(id, options) {
          session.active(options);
          return handle.read((world) => job(world, id));
        },
        async startExport(input, options) {
          const invocation = session.fresh(options);
          const parsed = S.exportRequestSchema.safeParse(input);
          if (!parsed.success) return invalidInput();
          const request = parsed.data;
          const initial = handle.read((world) => selection(world, request));
          if (initial.privateSources.length && !request.reason)
            return invalidInput();
          let next = committed;
          const result = await handle.command<C.BinaryDownload, C.ExportJob>({
            signal: session.signal(options),
            async prepare(signal) {
              if (initial.privateSources.length)
                await invocation.prepare(signal);
              session.active({ signal });
              const media_type = "text/csv; charset=utf-8";
              return {
                bytes: new Blob(
                  ['"source","content"\r\n"OpenComms","Local sample export"'],
                  { type: media_type },
                ),
                filename: "opencomms-sample.csv",
                media_type,
              };
            },
            authorize(world) {
              const current = selection(world, request);
              if (initial.privateSources.length) invocation.assert();
              if (current.witness !== initial.witness) session.stale();
            },
            apply(draft, execution, prepared) {
              const id = execution.uuid();
              if (Object.hasOwn(draft.exports, id)) return invalidMemoryState();
              const timestamp = new Date(execution.now).toISOString();
              const row: C.ExportJob = {
                id,
                org_id: handle.context.org_id,
                requested_by: handle.context.user_id,
                created_at: timestamp,
                updated_at: timestamp,
                request,
                status: "succeeded",
                failure_code: null,
              };
              draft.exports[id] = row;
              next = new Map(committed);
              next.set(id, {
                job: session.describe(row),
                private_sources: initial.privateSources,
                download: prepared,
              });
              return {
                kind: "commit",
                value: row,
                version_keys: [`export:${id}`],
                publications: [],
              };
            },
            finalize: () => {
              committed = next;
              return undefined;
            },
          });
          return result.value;
        },
        async downloadExport(id, options) {
          session.active(options);
          return handle.read((world) => {
            const row = job(world, id);
            const current = sources(world, row.request);
            const privateSources = current
              .filter(
                (room) => room.kind !== "channel" || room.scope === "members",
              )
              .map((room) => room.id)
              .sort();
            const entry = committed.get(id);
            if (
              row.status !== "succeeded" ||
              !entry ||
              entry.job !== session.describe(row) ||
              session.describe(entry.private_sources) !==
                session.describe(privateSources) ||
              (entry.private_sources.length > 0 && !row.request.reason)
            )
              return unavailable();
            return entry.download;
          });
        },
      };
    },
  };
}
