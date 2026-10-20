import type { Page, WebSocketRoute } from "@playwright/test";
import { createMemorySeed } from "../../../src/components/systems/comms/memory/seed";
import {
  createMemoryCommsRuntime,
  type MemoryCommsRuntime,
} from "../../../src/components/systems/comms/adapters/memory-client";
import * as S from "../../../src/components/systems/comms/contract/schemas";
import type * as C from "../../../src/components/systems/comms/contract/types";
import type {
  HistoryPage,
  LiveMessage,
  SettingsScope,
} from "../../../src/components/systems/comms/contract/types";
import { defaultOrganization, defaultSignedInIdentity } from "./test";

/** Existing frozen fixture supplies metadata DTOs only; all browser reads/writes cross HTTP. */
export async function installCommsLiveApi(
  page: Page,
  options: {
    userId?: string;
    organizationId?: string;
    channelName?: string;
    messagePrefix?: string;
    removedCount?: number;
    runtime?: MemoryCommsRuntime;
  } = {},
) {
  const owner = {
    user_id: options.userId ?? defaultSignedInIdentity.id,
    org_id: options.organizationId ?? defaultOrganization.org_id,
  };
  const memory =
    options.runtime ??
    createMemoryCommsRuntime({
      owner,
      initial: createMemorySeed(owner, {
        role: "admin",
        display_name: "HTTP fixture owner",
      }),
    });
  const initial = await memory.client.bootstrap();
  const summary = initial.conversations.find(
    (row) => row.conversation.kind === "channel",
  );
  const room =
    summary?.conversation.id ?? "94000000-0000-4000-8000-000000000000";
  const context = {
    ...owner,
    categories: initial.categories,
    conversations: summary
      ? [
          {
            ...summary,
            conversation: {
              ...summary.conversation,
              name: options.channelName ?? "live-operations",
            },
          },
        ]
      : [],
  };
  const histories: URL[] = [];
  const writes: string[] = [];
  const candidateQueries: string[] = [];
  const retentionProofs: boolean[] = [];
  const messages: LiveMessage[] = [];
  const sockets = new Set<WebSocketRoute>();
  let joinsPaused = false;
  let tokenStatus = 200;
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
  if (!options.runtime) for (let i = 0; i < 59; i++) append();
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
  const stopEvents = memory.client.events.subscribe({
    on_event: broadcast,
    on_connection: () => {},
    on_error: () => {},
  });
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
  await page.route("**/api/realtime/token", async (route) => {
    if (route.request().headers()["x-org"] !== owner.org_id)
      return route.fallback();
    if (tokenStatus !== 200)
      return route.fulfill({
        status: tokenStatus,
        json: { detail: "Live updates unavailable" },
      });
    const now = await page.evaluate(() => Date.now());
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
  await page.route(
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
  await page.route("**/api/comms/**", async (route) => {
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
      if (error instanceof Error && "failure" in error) {
        const failure = S.commsFailureSchema.parse(error.failure);
        return reply(failure.body, failure.status);
      }
      throw error;
    };
    if (request.headers()["x-org"] !== owner.org_id) return route.fallback();
    try {
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
        if (path === "/bootstrap") return reply(await client.bootstrap());
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
        if (path === "/capabilities/channel-creation") {
          const kind = url.searchParams.get("scope_kind");
          return reply(
            await client.getChannelCreationCheck(
              kind === "category"
                ? { kind, id: url.searchParams.get("category_id")! }
                : { kind: "workspace" },
            ),
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
        return version(memory.client.getSettings(scope));
      }
      if (path === `/conversations/${room}/capabilities`)
        return reply(await memory.client.getCapabilities(room));
      if (path === `/conversations/${room}/members`)
        return reply(
          await memory.client.listMembers(room, {
            limit: Number(url.searchParams.get("limit")),
            offset: Number(url.searchParams.get("offset")),
          }),
        );
      if (path === "/presence")
        return reply({ org_id: owner.org_id, items: [] });
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
  return {
    room,
    histories,
    writes,
    retentionProofs,
    connections: () => sockets.size,
    candidateQueries,
    setTokenStatus(value: number) {
      tokenStatus = value;
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
