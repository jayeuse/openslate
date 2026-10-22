import type { Page } from "@playwright/test";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import type { SearchHit } from "../../../src/components/systems/comms/contract/types";
import { installCommsLiveApi } from "./comms-live-api";
import {
  defaultOrganization,
  defaultSignedInIdentity,
  authMeBody,
} from "./test";

type SearchReply = { status?: number; items?: SearchHit[]; total?: number };
export async function installCommsSearchApi(
  page: Page,
  options: {
    userId?: string;
    orgId?: string;
    prefix?: string;
    workspaceEvents?: boolean;
  } = {},
) {
  const owner = {
    user_id: options.userId ?? defaultSignedInIdentity.id,
    org_id: options.orgId ?? defaultOrganization.org_id,
  };
  const state = createMemorySeed(owner, {
    role: "admin",
    display_name: "Search owner",
  });
  const rooms = Object.values(state.conversations).filter(
    (room) => room.kind === "channel",
  );
  const first = rooms[0];
  if (!first) throw new Error("Owned search fixture needs a channel");
  const second = {
    ...first,
    id: "7b000000-0000-4000-8000-000000000001",
    position: 1,
  };
  state.conversations[second.id] = second;
  state.members[second.id] = structuredClone(state.members[first.id]);
  first.name = "Search dispatch";
  second.name = "Search archive";
  const root = Object.values(state.messages).find(
    (row) => row.conversation_id === first.id && !row.parent_id,
  );
  const reply = Object.values(state.messages).find(
    (row) => row.conversation_id === first.id && row.parent_id,
  );
  if (!root || !reply)
    throw new Error("Owned search fixture needs root and reply sources");
  const other = {
    ...root,
    id: "7b000000-0000-4000-8000-000000000002",
    client_key: "7b000000-0000-4000-8000-000000000003",
    conversation_id: second.id,
    seq: 1,
    record_links: [],
  };
  state.messages[other.id] = other;
  state.high_water_seq[second.id] = 1;
  root.body = options.prefix ?? "😀 İ comet <b>plain</b>";
  other.body = options.prefix
    ? `${options.prefix} archive`
    : "Archive needle target";
  reply.body = options.prefix
    ? `${options.prefix} reply`
    : "Thread needle reply";
  for (const row of [root, other, reply]) row.author_id = owner.user_id;
  for (const thread of Object.values(state.threads))
    if (thread.root_message_id === root.id) thread.starter_id = owner.user_id;
  const runtime = createMemoryCommsRuntime({ owner, initial: state });
  const server = await installCommsLiveApi(page, {
    runtime,
    userId: owner.user_id,
    organizationId: owner.org_id,
    workspaceEvents: options.workspaceEvents,
  });
  const hit = (row: typeof root, name: string): SearchHit => ({
    message_id: row.id,
    conversation_id: row.conversation_id,
    conversation_name: name,
    seq: row.seq,
    author_id: row.author_id,
    author_name: "Search owner",
    created_at: row.created_at,
    excerpt: row.body,
    parent_id: row.parent_id,
    matches:
      row.id === root.id && !options.prefix
        ? [
            { start: 4, end: 9 },
            { start: 4, end: 8 },
          ]
        : [],
  });
  const primaryHit = hit(root, first.name),
    otherHit = hit(other, second.name),
    replyHit = hit(reply, first.name);
  const requests: URL[] = [];
  let respond: (url: URL) => SearchReply | Promise<SearchReply> = (url) => ({
    items: [
      url.searchParams.get("q") === "thread"
        ? replyHit
        : url.searchParams.get("q") === "needle"
          ? otherHit
          : primaryHit,
    ],
  });
  await page.route("**/api/comms/search?**", async (route) => {
    if (route.request().headers()["x-org"] !== owner.org_id)
      return route.fallback();
    const url = new URL(route.request().url());
    // The cold load's one record-link read (has=record, 100 per page) is not
    // a search the person ran; only searches from the dialog are counted.
    if (
      url.searchParams.get("has") !== "record" ||
      url.searchParams.get("limit") !== "100"
    )
      requests.push(url);
    const result = await respond(url);
    const status = result.status ?? 200,
      items = result.items ?? [];
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const total = result.total ?? offset + items.length;
    await route.fulfill({
      status,
      json:
        status === 200
          ? {
              items,
              pagination: {
                offset,
                limit,
                count: items.length,
                total,
                has_more: offset + items.length < total,
              },
            }
          : {
              detail: {
                code:
                  status === 403
                    ? "comms_capability_denied"
                    : "comms_unavailable",
                message: "PRIVATE FAILURE TEXT MUST NOT BE SHOWN",
              },
            },
    });
  });
  return {
    ...server,
    owner,
    room: first.id,
    otherRoom: second.id,
    primaryHit,
    otherHit,
    replyHit,
    searchRequests: requests,
    setSearchReply: (next: typeof respond) => {
      respond = next;
    },
  };
}

export async function searchIdentity(page: Page) {
  // Organization switching lands on OpenView before returning to OpenComms.
  await page.route("**/api/views/data-sources?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        items: [],
        pagination: {
          limit: Number(url.searchParams.get("limit") ?? 100),
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    });
  });
  const primary = { ...defaultOrganization, role: "admin" as const };
  const other = {
    ...primary,
    org_id: "7a000000-0000-4000-8000-000000000002",
    name: "Search partner",
    slug: "search-partner",
  };
  const state: { userId: string; organization: typeof other } = {
    userId: defaultSignedInIdentity.id,
    organization: primary,
  };
  const me = () =>
    authMeBody({
      id: state.userId,
      role: "admin",
      memberships: [primary, other],
      current_organization: { ...state.organization, access: [] },
    });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: state.userId,
        organization_id: state.organization.org_id,
        setup_required: false,
        default_organization_blocked: null,
      },
    }),
  );
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: me() }));
  await page.route("**/api/auth/session/organization", (route) => {
    const selected: unknown = route.request().postDataJSON();
    if (!selected || typeof selected !== "object" || !("org_id" in selected))
      return route.fulfill({ status: 422 });
    state.organization = selected.org_id === other.org_id ? other : primary;
    return route.fulfill({ json: me() });
  });
  return { state, primary, other };
}
