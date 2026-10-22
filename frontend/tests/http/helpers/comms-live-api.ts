import type { Page, Route, WebSocketRoute } from "@playwright/test";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import {
  createMemoryCommsRuntime,
  type MemoryCommsRuntime,
} from "../../support/comms-memory/memory-client";
import * as S from "../../../src/components/systems/comms/contract/schemas";
import type * as C from "../../../src/components/systems/comms/contract/types";
import type {
  HistoryPage,
  LiveMessage,
  SettingsScope,
} from "../../../src/components/systems/comms/contract/types";
import { defaultOrganization, defaultSignedInIdentity } from "./test";
import { installOpenViewEventSource } from "./openview-event-source";
import { commsToolRoute } from "./comms-tool-routes";

// Two organization fixtures on one page still exercise its single socket.
const pageSockets = new WeakMap<Page, Set<WebSocketRoute>>();

type RouteMatcher = Parameters<Page["route"]>[0];
type RouteHandler = (route: Route) => unknown;
/** One queued refusal; `body` is sent as JSON unless the status is 204. */
type QueuedFailure = {
  pattern: RegExp;
  status: number;
  body: unknown;
  method?: string;
};

/**
 * Existing frozen fixture supplies metadata DTOs only; all browser reads/writes cross HTTP.
 *
 * With `runtime`, every Comms route answers from that memory runtime, including
 * thread follow, reactions, pins, record references, direct blocks and the
 * attachment reserve/upload/download routes. `notifications: true` also serves
 * `/api/notifications` from the runtime's stored notices (opt-in, so existing
 * callers keep the base fixture's empty list). `clock` stamps notification
 * reads and the runtime this helper builds when no `runtime` is passed; a
 * caller-built runtime must receive the same clock itself.
 */
export async function installCommsLiveApi(
  page: Page,
  options: {
    userId?: string;
    organizationId?: string;
    channelName?: string;
    messagePrefix?: string;
    removedCount?: number;
    runtime?: MemoryCommsRuntime;
    workspaceEvents?: boolean;
    messageStore?: LiveMessage[];
    empty?: boolean;
    uncategorized?: boolean;
    role?: "admin" | "member" | "guest";
    notifications?: boolean;
    clock?: () => number;
  } = {},
) {
  if (options.workspaceEvents !== false)
    await installOpenViewEventSource(page, { autoResync: true });
  const owner = {
    user_id: options.userId ?? defaultSignedInIdentity.id,
    org_id: options.organizationId ?? defaultOrganization.org_id,
  };
  const now = options.clock ?? Date.now;
  const memory =
    options.runtime ??
    createMemoryCommsRuntime(
      {
        owner,
        initial: createMemorySeed(owner, {
          role: options.role ?? "admin",
          display_name: "HTTP fixture owner",
        }),
      },
      options.clock ? { clock: options.clock } : {},
    );
  // Every page route this install adds, so `uninstall()` can remove exactly these.
  const owned: [RouteMatcher, RouteHandler][] = [];
  const own = (matcher: RouteMatcher, handler: RouteHandler) => {
    owned.push([matcher, handler]);
    return page.route(matcher, handler);
  };
  const failures: QueuedFailure[] = [];
  const takeFailure = (method: string, path: string) => {
    const index = failures.findIndex(
      (failure) =>
        failure.pattern.test(path) &&
        (!failure.method || failure.method === method),
    );
    return index < 0 ? undefined : failures.splice(index, 1)[0];
  };
  const initial = await memory.client.bootstrap();
  const summary = initial.conversations.find(
    (row) => row.conversation.kind === "channel",
  );
  const room =
    summary?.conversation.id ?? "94000000-0000-4000-8000-000000000000";
  const context = {
    ...owner,
    categories:
      options.empty || options.uncategorized ? [] : initial.categories,
    conversations:
      summary && !options.empty
        ? [
            {
              ...summary,
              conversation: {
                ...summary.conversation,
                name: options.channelName ?? "live-operations",
                ...(options.uncategorized &&
                summary.conversation.kind === "channel"
                  ? { category_id: null }
                  : {}),
              },
              ...(options.uncategorized
                ? { preferences: { ...summary.preferences, starred: false } }
                : {}),
            },
          ]
        : [],
  };
  const histories: URL[] = [];
  const writes: string[] = [];
  const candidateQueries: string[] = [];
  const retentionProofs: boolean[] = [];
  const heartbeats: { orgId: string; state: string }[] = [];
  const messages: LiveMessage[] = options.messageStore ?? [];
  const sockets = pageSockets.get(page) ?? new Set<WebSocketRoute>();
  pageSockets.set(page, sockets);
  let joinsPaused = false;
  let tokenStatus = 200;
  let tokenRetryAfter: number | undefined;
  let joinLimit: string | null = null;
  let tokenRequests = 0;
  const typingRequests: string[] = [];
  const presenceStates = new Map<string, "online" | "away" | "offline">();
  const members = summary
    ? (await memory.client.listMembers(room, { limit: 100, offset: 0 })).items
    : [];
  let postAllowed = true,
    channelLocked = false;
  const id = (seq: number) =>
    `94000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  function append(body?: string, key?: string) {
    const seq = messages.length + 1;
    const message: LiveMessage = {
      id: id(seq),
      org_id: owner.org_id,
      conversation_id: room,
      seq,
      author_id: owner.user_id,
      client_key: key ?? id(seq + 10000),
      created_at: "2026-01-01T00:00:00Z",
      parent_id: null,
      reply_to_id: null,
      also_send_to_channel: false,
      thread: null,
      state: "live",
      body: body ?? `${options.messagePrefix ?? "Live message"} ${seq}`,
      edited_at: null,
      pinned_at: null,
      pinned_by: null,
      attachments: [],
      record_references: [],
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
      reactions: [],
      link_previews: [],
    };
    messages.push(message);
    return message;
  }
  if (!options.runtime && messages.length === 0)
    for (let i = 0; i < 59; i++) append();
  const broadcast = (event: C.CommsEvent) => {
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          topic: `realtime:${event.topic}`,
          event: "broadcast",
          payload: {
            type: "broadcast",
            event: event.event,
            payload: event.payload,
          },
          ref: null,
        }),
      );
  };
  const subscribeEvents = () =>
    memory.client.events.subscribe({
      on_event: broadcast,
      on_connection: () => {},
      on_error: () => {},
    });
  // A role change rebinds the runtime's owner handle, which ends this subscription.
  let stopEvents = subscribeEvents();
  const close = () => {
    stopEvents();
    memory.dispose();
  };
  page.once("close", close);
  await page.routeWebSocket("**/realtime/v1/websocket**", (socket) => {
    sockets.add(socket);
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (joinsPaused && frame.event === "phx_join") return;
      if (joinLimit && frame.event === "phx_join") {
        socket.send(
          JSON.stringify({
            ...frame,
            event: "phx_reply",
            payload: { status: "error", response: { reason: joinLimit } },
          }),
        );
        return;
      }
      if (["phx_join", "phx_leave", "heartbeat"].includes(frame.event))
        socket.send(
          JSON.stringify({
            ...frame,
            event: "phx_reply",
            payload: { status: "ok", response: {} },
          }),
        );
    });
    socket.onClose(() => {
      sockets.delete(socket);
    });
  });
  await own("**/api/realtime/token", async (route) => {
    if (route.request().headers()["x-org"] !== owner.org_id)
      return route.fallback();
    tokenRequests += 1;
    if (tokenStatus !== 200)
      return route.fulfill({
        status: tokenStatus,
        json: { detail: "Live updates unavailable" },
        headers:
          tokenRetryAfter === undefined
            ? {}
            : { "Retry-After": String(tokenRetryAfter) },
      });
    // A navigation can replace the page mid-read; the Node clock is then close enough.
    const now = await page.evaluate(() => Date.now()).catch(() => Date.now());
    const topics = options.runtime
      ? (await memory.client.bootstrap()).conversations
          .map(
            (row) => `org:${owner.org_id}:conversation:${row.conversation.id}`,
          )
          .sort()
      : [`org:${owner.org_id}:conversation:${room}`];
    return route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: {
        access_token: "owned-test-realtime-token",
        expires_at: new Date(now + 300000).toISOString(),
        topic_prefix: `org:${owner.org_id}:`,
        conversation_topics: topics,
      },
    });
  });
  const empty = (url: URL) => ({
    items: [],
    pagination: {
      limit: Number(url.searchParams.get("limit") ?? 25),
      offset: Number(url.searchParams.get("offset") ?? 0),
      count: 0,
      total: 0,
      has_more: false,
    },
  });
  await own(
    (url) =>
      ["/api/access/groups", "/api/departments", "/api/modules"].includes(
        url.pathname,
      ),
    (route) => {
      if (route.request().headers()["x-org"] !== owner.org_id)
        return route.fallback();
      const url = new URL(route.request().url()),
        state = memory.exportSnapshot().state;
      const fields = {
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      };
      const rows =
        url.pathname === "/api/access/groups"
          ? Object.values(state.groups).map((group) => ({
              ...fields,
              id: group.id,
              name: group.name,
              description: "",
              revision: 0,
              member_ids: Object.values(state.people)
                .filter((person) => person.group_ids.includes(group.id))
                .map((person) => person.user_id),
              access: [],
            }))
          : url.pathname === "/api/departments"
            ? Object.values(state.departments).map((department) => ({
                ...fields,
                id: department.id,
                department_name: department.name,
              }))
            : Object.values(state.modules).map((module) => ({
                ...fields,
                id: module.id,
                // The retained synthetic seed places its record module in its one department.
                department_id: Object.keys(state.departments)[0],
                module_name: module.name,
                title_field_id: null,
              }));
      const limit = Number(url.searchParams.get("limit") ?? 25),
        offset = Number(url.searchParams.get("offset") ?? 0);
      const items = rows.slice(offset, offset + limit);
      return route.fulfill({
        json: {
          items,
          pagination: {
            limit,
            offset,
            count: items.length,
            total: rows.length,
            has_more: offset + items.length < rows.length,
          },
        },
      });
    },
  );
  let loseNextReceipt = false;
  let refuseHistory = false;
  const requests: { method: string; path: string; ifMatch?: string }[] = [];
  const conflicts: RegExp[] = [];
  await own("**/api/comms/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/comms", "");
    const reply = (
      json: unknown,
      status = 200,
      etag = '"fixture-1"',
      location?: string,
    ) =>
      route.fulfill({
        status,
        ...(status === 204 ? {} : { json }),
        headers: {
          ETag: etag,
          "Cache-Control": "private, no-store",
          ...(location ? { Location: location } : {}),
        },
      });
    const version = async (value: Promise<{ data: unknown; etag: string }>) => {
      try {
        const result = await value;
        await reply(result.data, 200, result.etag);
      } catch (error) {
        await refused(error);
      }
    };
    const refused = (error: unknown) => {
      if (page.isClosed()) return Promise.resolve();
      if (error instanceof Error && "failure" in error) {
        const failure = S.commsFailureSchema.parse(error.failure);
        // Like the backend, every Comms 429 carries its wait as Retry-After.
        if (failure.status === 429)
          return route.fulfill({
            status: 429,
            json: failure.body,
            headers: {
              "Cache-Control": "private, no-store",
              "Retry-After": String(failure.retry_after_seconds),
            },
          });
        return reply(failure.body, failure.status);
      }
      throw error;
    };
    if (request.headers()["x-org"] !== owner.org_id) return route.fallback();
    requests.push({
      method: request.method(),
      path,
      ifMatch: request.headers()["if-match"],
    });
    const conflict = conflicts.findIndex(
      (pattern) => request.method() !== "GET" && pattern.test(path),
    );
    if (conflict >= 0) {
      conflicts.splice(conflict, 1);
      return reply(
        {
          detail: {
            code: "comms_precondition_failed",
            message: "Precondition failed",
          },
        },
        412,
      );
    }
    const failure = takeFailure(request.method(), path);
    if (failure) return reply(failure.body, failure.status);
    try {
      if (path === "/capabilities/channel-creation") {
        const kind = url.searchParams.get("scope_kind");
        return reply(
          await memory.client.getChannelCreationCheck(
            kind === "category"
              ? { kind, id: url.searchParams.get("category_id")! }
              : { kind: "workspace" },
          ),
        );
      }
      if (options.runtime) {
        const client = memory.client,
          method = request.method();
        const query = Object.fromEntries(
          [...url.searchParams].map(([key, value]) => [
            key,
            [
              "limit",
              "offset",
              "before_seq",
              "after_seq",
              "around_seq",
            ].includes(key)
              ? Number(value)
              : key === "archived"
                ? value === "true"
                : value,
          ]),
        );
        const condition = { if_match: request.headers()["if-match"] };
        const body = () => request.postDataJSON();
        const tool = await commsToolRoute({
          client,
          method,
          path,
          url,
          body,
          ifMatch: request.headers()["if-match"],
        });
        if (tool?.bytes)
          return route.fulfill({
            status: tool.status,
            body: tool.bytes.body,
            headers: {
              "Content-Type": tool.bytes.type,
              "Content-Disposition": `attachment; filename="${tool.bytes.filename}"`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        if (tool)
          return reply(tool.json, tool.status, tool.etag, tool.location);
        if (path === "/bootstrap") return reply(await client.bootstrap());
        // D45 grants and their candidate search, on a channel or a category.
        const access = path.match(
          /^\/(conversations|categories)\/([^/]+)\/access-(grants|candidates)(?:\/(group|user)\/([^/]+))?$/,
        );
        if (access) {
          const [, collection, targetId, resource, subject, subjectId] =
            access as unknown as [
              string,
              string,
              string,
              string,
              "group" | "user" | undefined,
              string,
            ];
          const target = {
            kind: collection === "conversations" ? "channel" : "category",
            id: targetId,
          } as const;
          if (resource === "candidates") {
            const kind = url.searchParams.get("kind");
            return reply(
              await client.listAccessCandidates(target, {
                q: url.searchParams.get("q") ?? "",
                limit: Number(url.searchParams.get("limit") ?? 20),
                ...(kind === "user" || kind === "group" ? { kind } : {}),
              }),
            );
          }
          if (!subject) return version(client.listAccessGrants(target));
          if (method === "DELETE") {
            await client.removeAccessGrant(
              target,
              subject,
              subjectId,
              condition,
            );
            return reply(null, 204);
          }
          const existed = Object.hasOwn(
            memory.exportSnapshot().state.access_grants,
            `${target.kind}:${targetId}:${subject}:${subjectId}`,
          );
          const result = await client.setAccessGrant(
            target,
            subject,
            subjectId,
            body(),
            condition,
          );
          return reply(
            result.data,
            existed ? 200 : 201,
            result.etag,
            existed ? undefined : `/api/comms${path}`,
          );
        }
        if (path === "/conversations" && method === "GET")
          return reply(
            await client.listConversations(
              S.conversationListRequestSchema.parse(query),
            ),
          );
        if (path === "/categories") {
          if (method === "GET")
            return reply(
              await client.listCategories(
                S.categoryListRequestSchema.parse(query),
              ),
            );
          const result = await client.createCategory(body());
          return reply(
            result.data,
            201,
            result.etag,
            `/api/comms/categories/${result.data.id}`,
          );
        }
        const category = path.match(/^\/categories\/([^/]+)(\/preferences)?$/);
        if (category) {
          if (category[2])
            return method === "GET"
              ? version(client.getCategoryPreferences(category[1]))
              : version(
                  client.setCategoryPreferences(category[1], body(), {
                    if_match: (await client.getCategoryPreferences(category[1]))
                      .etag,
                  }),
                );
          return version(
            method === "GET"
              ? client.getCategory(category[1])
              : client.updateCategory(category[1], body(), condition),
          );
        }
        if (path === "/threads")
          return reply(
            await client.listThreads(S.threadListRequestSchema.parse(query)),
          );
        if (path === "/search")
          return reply(await client.search(S.searchRequestSchema.parse(query)));
        if (path === "/direct-blocks" && method === "POST") {
          await client.blockDirect(body());
          return reply(null, 204);
        }
        const unblock = path.match(/^\/direct-blocks\/([^/]+)$/);
        if (unblock && method === "DELETE") {
          await client.unblockDirect(unblock[1]);
          return reply(null, 204);
        }
        if (path === "/direct-blocks")
          return reply(
            await client.listDirectBlocks(S.timeListRequestSchema.parse(query)),
          );
        if (path === "/record-references")
          return reply(
            await client.listLinkedRecords(
              S.timeListRequestSchema.parse(query),
            ),
          );
        if (path === "/direct-candidates") {
          const q = url.searchParams.get("q") ?? "";
          candidateQueries.push(q);
          const candidates = await client.listDirectCandidates({
            search: q,
            limit: Number(url.searchParams.get("limit") ?? 20),
          });
          return reply({
            items: candidates.items.map((person) => ({
              ...person,
              avatar_url: null,
            })),
          });
        }
        if (path === "/directs" || path === "/groups") {
          const result =
            path === "/directs"
              ? await client.findOrCreateDirect(body())
              : await client.createGroup(body());
          return reply(
            result.data,
            201,
            result.etag,
            `/api/comms/conversations/${result.data.id}`,
          );
        }
        if (path === "/preferences" && method === "PUT")
          return version(
            client.setPersonalPreferences(body(), {
              if_match: (await client.getPersonalPreferences()).etag,
            }),
          );
        if (path === "/conversations" && method === "POST") {
          const result = await client.createChannel(body());
          return reply(
            result.data,
            201,
            result.etag,
            `/api/comms/conversations/${result.data.id}`,
          );
        }
        const scoped = path.match(/^\/conversations\/([^/]+)(.*)$/);
        if (scoped) {
          const [, conversationId, tail] = scoped;
          if (!tail)
            return version(
              method === "GET"
                ? client.getConversation(conversationId)
                : client.updateChannel(conversationId, body(), condition),
            );
          if (tail === "/capabilities")
            return reply(await client.getCapabilities(conversationId));
          if (tail === "/members")
            return reply(
              await client.listMembers(
                conversationId,
                S.memberListRequestSchema.parse(query),
              ),
            );
          if (tail === "/read")
            return reply(await client.markRead(conversationId, body()));
          if (tail === "/preferences")
            return method === "GET"
              ? version(client.getMemberPreferences(conversationId))
              : version(
                  client.updateMemberPreferences(conversationId, body(), {
                    if_match: (
                      await client.getMemberPreferences(conversationId)
                    ).etag,
                  }),
                );
          if (tail === "/pins")
            return reply(
              await client.listPins(
                conversationId,
                S.timeListRequestSchema.parse(query),
              ),
            );
          if (tail === "/removed-messages")
            return reply(
              await client.listRemovedMessages(
                conversationId,
                S.timeListRequestSchema.parse(query),
              ),
            );
          // The fixture room keeps its own typing switch (setPosting) below.
          if (
            tail === "/typing" &&
            method === "POST" &&
            conversationId !== room
          ) {
            await client.sendTyping(conversationId);
            return reply(null, 204);
          }
          const reference = tail.match(/^\/record-references\/([^/]+)$/);
          if (reference && method === "GET")
            return reply(
              await client.getRecordReference(conversationId, reference[1]),
            );
          if (tail === "/files" && method === "POST") {
            const file = await client.reserveAttachment(conversationId, body());
            return reply(
              file,
              201,
              '"fixture-1"',
              `/api/comms/conversations/${conversationId}/files/${file.id}`,
            );
          }
          const content = tail.match(/^\/files\/([^/]+)\/content$/);
          if (content && method === "PUT")
            return reply(
              await client.uploadAttachment(
                conversationId,
                content[1],
                new Blob([new Uint8Array(request.postDataBuffer() ?? [])]),
              ),
            );
          if (content && method === "GET") {
            const file = await client.downloadAttachment(
              conversationId,
              content[1],
            );
            // The backend's exact download headers; the adapter checks each one.
            return route.fulfill({
              status: 200,
              body: Buffer.from(await file.bytes.arrayBuffer()),
              headers: {
                "Content-Type": file.media_type,
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
              },
            });
          }
          const interaction = tail.match(
            /^\/messages\/([^/]+)\/(reactions|pin)$/,
          );
          if (interaction) {
            const [, messageId, kind] = interaction;
            if (kind === "pin" && method === "PUT")
              return reply(
                await client.setPin(conversationId, messageId, body()),
              );
            if (kind === "reactions" && method === "POST")
              return reply(
                await client.addReaction(conversationId, messageId, body()),
              );
            if (kind === "reactions" && method === "DELETE")
              return reply(
                await client.removeReaction(conversationId, messageId, body()),
              );
          }
          const follow = tail.match(/^\/threads\/([^/]+)\/follow$/);
          if (follow && method === "PUT")
            return reply(
              await client.followThread(conversationId, follow[1], body()),
            );
          if (tail === "/messages") {
            if (method === "GET") {
              histories.push(url);
              return reply(
                await client.getHistory(
                  conversationId,
                  S.historyRequestSchema.parse(query),
                ),
              );
            }
            const result = await client.sendMessage(conversationId, body());
            writes.push(body().client_key);
            return reply(result.message, result.status);
          }
          const sequence = tail.match(/^\/messages\/by-sequence\/(\d+)$/);
          if (sequence)
            return version(
              client.getMessageBySequence(conversationId, Number(sequence[1])),
            );
          const message = tail.match(/^\/messages\/([^/]+)$/);
          if (message)
            return version(
              method === "GET"
                ? client.getMessage(conversationId, message[1])
                : method === "PATCH"
                  ? client.editMessage(conversationId, message[1], body())
                  : client.deleteMessage(conversationId, message[1]),
            );
          const thread = tail.match(/^\/threads\/([^/]+)(\/replies)?$/);
          if (thread) {
            if (thread[2]) {
              if (method === "GET") {
                histories.push(url);
                return reply(
                  await client.getReplies(
                    conversationId,
                    thread[1],
                    S.historyRequestSchema.parse(query),
                  ),
                );
              }
              const sent = await client.sendReply(
                conversationId,
                thread[1],
                body(),
              );
              return reply(
                sent.message,
                sent.status,
                '"reply-1"',
                `/api/comms/conversations/${conversationId}/messages/${sent.message.id}`,
              );
            }
            if (method === "GET")
              return version(client.getThread(conversationId, thread[1]));
            if (method === "PATCH")
              return version(
                client.updateThread(
                  conversationId,
                  thread[1],
                  body(),
                  condition,
                ),
              );
            const created = await client.createThread(
              conversationId,
              thread[1],
            );
            return reply(
              created.data,
              201,
              created.etag,
              `/api/comms/conversations/${conversationId}/threads/${thread[1]}`,
            );
          }
        }
        if (path.startsWith("/settings/") && method === "PATCH") {
          const [, , kind, target] = path.split("/");
          return version(
            client.updateSettings(
              kind === "workspace"
                ? { kind }
                : { kind: kind as "category" | "channel", id: target },
              body(),
              condition,
            ),
          );
        }
      }
      if (path === "/bootstrap")
        return reply({
          ...context,
          conversations: context.conversations.map((row) => ({
            ...row,
            high_water_seq: messages.length,
            last_read_seq: 0,
            unread_count: 0,
            mention_count: 0,
            first_unread_seq: null,
          })),
        });
      if (path === "/preferences")
        return version(memory.client.getPersonalPreferences());
      if (path === `/conversations/${room}`)
        return reply(context.conversations[0].conversation);
      if (path === "/retention")
        return reply({
          policy: {
            scope: { kind: "workspace" },
            message_days: 30,
            file_days: 0,
          },
          effective: { message_days: 30, file_days: 0 },
          sources: { message_days: "workspace", file_days: "workspace" },
        });
      if (path === "/retention/preview") {
        const input = request.postDataJSON();
        retentionProofs.push(input.password === "owned-synthetic-proof");
        return reply({
          policy: {
            scope: input.scope,
            message_days: input.message_days,
            file_days: input.file_days,
          },
          effective: {
            message_days: input.message_days,
            file_days: input.file_days,
          },
          sources: { message_days: "workspace", file_days: "workspace" },
          message_count: 1,
          file_count: 0,
          preview_digest: "c".repeat(64),
          expires_at: new Date(Date.now() + 300000).toISOString(),
        });
      }
      if (path.startsWith("/settings/")) {
        const [, , kind, target, suffix] = path.split("/");
        const scope: SettingsScope =
          kind === "workspace"
            ? { kind }
            : { kind: kind as "category" | "channel", id: target };
        if (path.endsWith("/capability-locks"))
          return version(memory.client.getCapabilityLocks());
        if (path.endsWith("/capabilities") || suffix === "capabilities")
          return version(memory.client.getCapabilityConfiguration(scope));
        const settings = await memory.client.getSettings(scope);
        if (scope.kind === "channel" && scope.id === room && channelLocked)
          settings.data.effective.locked = true;
        return version(Promise.resolve(settings));
      }
      if (path === `/conversations/${room}/capabilities`) {
        const check = await memory.client.getCapabilities(room);
        return reply(
          postAllowed ? check : { ...check, conversation_level: "read" },
        );
      }
      if (path === `/conversations/${room}/typing`) {
        typingRequests.push(request.headers()["x-org"]);
        return route.fulfill({
          status: postAllowed && !channelLocked ? 204 : 403,
        });
      }
      if (path === `/conversations/${room}/members`)
        return reply(
          await memory.client.listMembers(room, {
            limit: Number(url.searchParams.get("limit")),
            offset: Number(url.searchParams.get("offset")),
          }),
        );
      if (path === "/presence" && request.method() === "POST") {
        const input = request.postDataJSON();
        heartbeats.push({
          orgId: request.headers()["x-org"],
          state: input.state,
        });
        const rows = options.runtime
          ? (await memory.client.bootstrap()).conversations.map((row) => ({
              conversation_id: row.conversation.id,
              high_water_seq: row.high_water_seq,
            }))
          : [{ conversation_id: room, high_water_seq: messages.length }];
        const known = new Map(
          (input.known_sequences ?? []).map(
            (row: { conversation_id: string; high_water_seq: number }) => [
              row.conversation_id,
              row.high_water_seq,
            ],
          ),
        );
        const changed = rows
          .filter(
            (row) => known.get(row.conversation_id) !== row.high_water_seq,
          )
          .sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
        return reply({
          ...owner,
          changed: changed.slice(0, 100),
          truncated: changed.length > 100,
        });
      }
      if (path === "/presence")
        return reply({
          org_id: owner.org_id,
          items: url.searchParams
            .getAll("user_ids")
            .filter((id) => members.some((member) => member.user_id === id))
            .map((user_id) => ({
              user_id,
              state: presenceStates.get(user_id) ?? "offline",
            })),
        });
      if (path.endsWith("/removed-messages") && options.removedCount) {
        const limit = Number(url.searchParams.get("limit") ?? 25),
          offset = Number(url.searchParams.get("offset") ?? 0);
        const removed = Array.from(
          { length: options.removedCount },
          (_, index) => ({
            id: id(50000 + index),
            org_id: owner.org_id,
            conversation_id: room,
            seq: 50000 + index,
            author_id: owner.user_id,
            client_key: id(60000 + index),
            created_at: "2026-01-01T00:00:00Z",
            parent_id: null,
            reply_to_id: null,
            also_send_to_channel: false,
            thread: null,
            state: "deleted",
            deleted_at: "2026-01-02T00:00:00Z",
          }),
        );
        const items = removed.slice(offset, offset + limit);
        return reply({
          items,
          pagination: {
            limit,
            offset,
            count: items.length,
            total: removed.length,
            has_more: offset + items.length < removed.length,
          },
        });
      }
      if (path.endsWith("/read"))
        return reply({
          conversation_id: room,
          last_read_seq: request.postDataJSON().last_read_seq,
        });
      if (
        path === `/conversations/${room}/messages` &&
        request.method() === "POST"
      ) {
        const input = request.postDataJSON();
        writes.push(input.client_key);
        const existing = messages.find(
          (message) => message.client_key === input.client_key,
        );
        const sent = existing ?? append(input.body, input.client_key);
        if (loseNextReceipt) {
          loseNextReceipt = false;
          return reply({ detail: "Unavailable" }, 503);
        }
        return reply(sent, existing ? 200 : 201);
      }
      if (path === `/conversations/${room}/messages`) {
        if (refuseHistory) return reply({ detail: "Not found" }, 404);
        histories.push(url);
        const limit = Number(url.searchParams.get("limit") ?? 50),
          after = url.searchParams.get("after_seq"),
          before = url.searchParams.get("before_seq");
        const available = messages.filter(
          (item) =>
            (!after || item.seq > Number(after)) &&
            (!before || item.seq < Number(before)),
        );
        const items = after
          ? available.slice(0, limit)
          : available.slice(-limit);
        const result: HistoryPage = {
          org_id: owner.org_id,
          conversation_id: room,
          thread_root_id: null,
          items,
          pagination: {
            limit,
            count: items.length,
            first_seq: items[0]?.seq ?? null,
            last_seq: items.at(-1)?.seq ?? null,
            high_water_seq: messages.length,
            has_older: !!items.length && items[0].seq > 1,
            has_newer: !!items.length && items.at(-1)!.seq < messages.length,
          },
        };
        return reply(result);
      }
      if (path.includes("/messages/by-sequence/"))
        return reply(
          messages.find(
            (message) => message.seq === Number(path.split("/").at(-1)),
          ),
        );
      if (path.includes("/messages/"))
        return reply(
          messages.find((message) => message.id === path.split("/").at(-1)),
        );
      if (
        [
          "/threads",
          "/search",
          "/direct-blocks",
          "/record-references",
        ].includes(path) ||
        /\/(pins|removed-messages)$/.test(path)
      )
        return reply(empty(url));
      return reply(
        { detail: `Unmocked Comms operation: ${request.method()} ${path}` },
        500,
      );
    } catch (error) {
      return refused(error);
    }
  });
  // Notices the page marked read; the runtime itself only marks them read by sequence.
  const noticeReads = new Map<string, string>();
  async function storedNotices() {
    const rows: C.CommsNotification[] = [];
    // listActivity keeps only notices whose source message is still live.
    for (let offset = 0; ; offset += 100) {
      const result = await memory.client.listActivity({ limit: 100, offset });
      rows.push(...result.items);
      if (!result.pagination.has_more) break;
    }
    return rows.map((row) =>
      row.status === "unread" && noticeReads.has(row.id)
        ? { ...row, status: "read" as const, read_at: noticeReads.get(row.id)! }
        : row,
    );
  }
  if (options.notifications)
    await own(
      (url) => /^\/api\/notifications(\/|$)/.test(url.pathname),
      async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          method = request.method();
        if (request.headers()["x-org"] !== owner.org_id)
          return route.fallback();
        const failure = takeFailure(method, url.pathname);
        if (failure)
          return route.fulfill({
            status: failure.status,
            ...(failure.status === 204 ? {} : { json: failure.body }),
          });
        const rows = await storedNotices().catch((error: unknown) => {
          if (page.isClosed()) return null;
          throw error;
        });
        if (!rows) return;
        const markRead = /^\/api\/notifications\/([^/]+)\/read$/.exec(
          url.pathname,
        );
        if (method === "GET" && url.pathname === "/api/notifications") {
          const limit = Number(url.searchParams.get("limit") ?? 25),
            offset = Number(url.searchParams.get("offset") ?? 0);
          const matching =
            url.searchParams.get("status") === "unread"
              ? rows.filter((row) => row.status === "unread")
              : rows;
          const items = matching.slice(offset, offset + limit);
          return route.fulfill({
            json: {
              items,
              pagination: {
                limit,
                offset,
                count: items.length,
                total: matching.length,
                has_more: offset + items.length < matching.length,
              },
            },
          });
        }
        if (
          method === "GET" &&
          url.pathname === "/api/notifications/unread-count"
        )
          return route.fulfill({
            json: {
              unread_count: rows.filter((row) => row.status === "unread")
                .length,
            },
          });
        if (method === "POST" && markRead) {
          const row = rows.find((item) => item.id === markRead[1]);
          if (!row)
            return route.fulfill({
              status: 404,
              json: { detail: "Notification not found" },
            });
          const read_at = row.read_at ?? new Date(now()).toISOString();
          noticeReads.set(row.id, read_at);
          return route.fulfill({ json: { ...row, status: "read", read_at } });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/notifications/read-all"
        ) {
          const unread = rows.filter((row) => row.status === "unread");
          const read_at = new Date(now()).toISOString();
          for (const row of unread) noticeReads.set(row.id, read_at);
          return route.fulfill({ json: { updated_count: unread.length } });
        }
        return route.fallback();
      },
    );
  const publishAuthorizationChange = (
    event: "grants" | "structure" | "membership",
    conversationId = room,
  ) => {
    const topic = `org:${owner.org_id}:user:${owner.user_id}`;
    if (event === "membership")
      broadcast({
        topic,
        private: true,
        event,
        payload: { conversation_id: conversationId },
      });
    else broadcast({ topic, private: true, event, payload: {} });
  };
  let uninstalled: Promise<void> | undefined;
  return {
    room,
    members,
    typingRequests,
    /** The memory runtime behind every route; its client reads the same world. */
    runtime: memory,
    /**
     * A copy of the current world, for asserting what the page changed. It
     * throws after `close()` or `uninstall()`: read it before a swap.
     */
    snapshot: () => memory.exportSnapshot().state,
    /**
     * Admits the signed-in owner again with `role`, as the server does after a
     * membership change, and tells the page with a `grants` event (or
     * `membership` for `conversationId`, or no event with `"none"`). The page's
     * own session role is separate: change it with `signedInAs` when the
     * journey needs the shell to agree. Call it at a quiet point: a Comms
     * request still in flight is cancelled with the old admission.
     */
    setRole(
      role: "admin" | "member" | "guest",
      change: {
        event?: "grants" | "membership" | "none";
        conversationId?: string;
      } = {},
    ) {
      const person = memory.exportSnapshot().state.people[owner.user_id];
      if (!person) throw new Error("The world has no owner person");
      const ticket = memory.suspendAdmission();
      if (
        !memory.acceptAdmission(ticket, {
          context: owner,
          role,
          display_name: person.display_name,
        })
      )
        throw new Error("The role change was not admitted");
      stopEvents();
      stopEvents = subscribeEvents();
      const event = change.event ?? "grants";
      if (event !== "none")
        publishAuthorizationChange(event, change.conversationId);
    },
    /**
     * Answers the next matching request with `status` and `body` instead of
     * the world, once. The pattern is tested against the Comms path without
     * `/api/comms` (and, with `notifications`, the full `/api/notifications…`
     * path); `method` limits it to one HTTP method.
     */
    failNext(
      pattern: RegExp,
      status: number,
      body: unknown = { detail: "Unavailable" },
      method?: string,
    ) {
      failures.push({ pattern, status, body, method });
    },
    /**
     * Stops this world and removes every page route it added, so a later
     * install (another account or world) answers alone. The realtime socket
     * route cannot be removed: the newest install's socket route wins, and
     * open sockets stay shared by the page. The OpenView event-source route
     * (`workspaceEvents`) is not this install's and stays installed.
     */
    uninstall() {
      uninstalled ??= (async () => {
        page.off("close", close);
        if (!page.isClosed())
          await Promise.all(
            owned.map(([matcher, handler]) =>
              page.unroute(matcher, handler).catch((error: unknown) => {
                if (!page.isClosed()) throw error;
              }),
            ),
          );
        close();
      })();
      return uninstalled;
    },
    setPosting(allowed: boolean, locked = false) {
      postAllowed = allowed;
      channelLocked = locked;
      broadcast({
        topic: `org:${owner.org_id}:user:${owner.user_id}`,
        private: true,
        event: "membership",
        payload: { conversation_id: room },
      });
    },
    publishAuthorizationChange,
    publishTyping(userId: string, conversationId = room, orgId = owner.org_id) {
      broadcast({
        topic: `org:${orgId}:conversation:${conversationId}`,
        private: true,
        event: "typing",
        payload: { conversation_id: conversationId, user_id: userId },
      });
    },
    setPresence(
      userId: string,
      state: "online" | "away" | "offline",
      orgId = owner.org_id,
    ) {
      if (orgId === owner.org_id) presenceStates.set(userId, state);
      broadcast({
        topic: `org:${orgId}:presence`,
        private: true,
        event: "presence",
        payload: { user_id: userId, state },
      });
    },
    histories,
    writes,
    /** Every Comms request this page sent, with its If-Match precondition. */
    requests,
    /** Refuse the next write whose path matches with a 412 precondition failure. */
    conflictNextWrite(pattern: RegExp) {
      conflicts.push(pattern);
    },
    retentionProofs,
    heartbeats,
    connections: () => sockets.size,
    candidateQueries,
    tokenRequests: () => tokenRequests,
    setTokenStatus(value: number, retryAfter?: number) {
      tokenStatus = value;
      tokenRetryAfter = retryAfter;
    },
    setJoinLimit(value: string | null) {
      joinLimit = value;
    },
    appendQuietly() {
      return append();
    },
    pauseJoins(value: boolean) {
      joinsPaused = value;
    },
    dropConnections() {
      for (const socket of sockets)
        socket.close({ code: 1001, reason: "Owned test restart" });
    },
    loseNextReceipt() {
      loseNextReceipt = true;
    },
    refuseHistory(value: boolean) {
      refuseHistory = value;
    },
    publishEdit(seq: number, body: string) {
      const message = messages.find((row) => row.seq === seq);
      if (!message) throw new Error("Message fixture is missing");
      message.body = body;
      message.edited_at = "2026-01-02T00:00:00Z";
      broadcast({
        topic: `org:${owner.org_id}:conversation:${room}`,
        private: true,
        event: "message",
        payload: { conversation_id: room, seq, kind: "edited" },
      });
    },
    appendGap() {
      append();
      const newest = append();
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            topic: `realtime:org:${owner.org_id}:conversation:${room}`,
            event: "broadcast",
            payload: {
              type: "broadcast",
              event: "message",
              payload: {
                conversation_id: room,
                seq: newest.seq,
                kind: "created",
              },
            },
            ref: null,
          }),
        );
    },
    close,
  };
}
