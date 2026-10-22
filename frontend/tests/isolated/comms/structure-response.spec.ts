import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/structure-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import {
  calls,
  context,
  org,
  other,
  peer,
  user,
  conversationId,
  categoryId,
  channel,
  category,
  direct,
  group,
  member,
  block,
  etag,
  conditional,
  page,
  categoryRequest,
  channelRequest,
} from "./structure-fixtures";

test("structure get refuses another organization or resource identity", async () => {
  for (const body of [
    { ...channel, org_id: other },
    { ...channel, id: other },
  ]) {
    const mock = installFetch(() =>
      Response.json(body, { headers: { ETag: etag } }),
    );
    try {
      await expect(
        api.getConversation(context, conversationId),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("structure resource mutations and reads retain strict identity and target binding", async () => {
  for (const { call, body, status } of [
    {
      call: () => api.getCategory(context, categoryId),
      body: { ...category, id: other },
      status: 200,
    },
    {
      call: () => api.createCategory(context, categoryRequest),
      body: { ...category, org_id: other },
      status: 201,
    },
    {
      call: () =>
        api.updateCategory(context, categoryId, categoryRequest, conditional),
      body: { ...category, id: other },
      status: 200,
    },
    {
      call: () => api.createChannel(context, channelRequest),
      body: { ...channel, category_id: other },
      status: 201,
    },
    {
      call: () =>
        api.updateChannel(
          context,
          conversationId,
          { name: "New" },
          conditional,
        ),
      body: direct,
      status: 200,
    },
    {
      call: () => api.archiveConversation(context, conversationId, conditional),
      body: { ...channel, id: other },
      status: 200,
    },
    {
      call: () => api.restoreConversation(context, conversationId, conditional),
      body: { ...channel, org_id: other },
      status: 200,
    },
    {
      call: () => api.findOrCreateDirect(context, { recipient_id: peer }),
      body: { ...direct, participant_ids: [other, peer] },
      status: 201,
    },
    {
      call: () =>
        api.createGroup(context, { participant_ids: [user, peer, other] }),
      body: { ...group, participant_ids: [user, peer, categoryId] },
      status: 201,
    },
    {
      call: () =>
        api.setMemberRole(
          context,
          conversationId,
          peer,
          { role: "manager" },
          conditional,
        ),
      body: { ...member, user_id: other },
      status: 200,
    },
    {
      call: () =>
        api.duplicateChannel(
          context,
          conversationId,
          { name: "Copy", category_id: categoryId },
          conditional,
        ),
      body: channel,
      status: 201,
    },
  ]) {
    const mock = installFetch(() =>
      Response.json(body, {
        status,
        headers: {
          ETag: etag,
          Location: `/api/comms/${"kind" in body ? "conversations" : "categories"}/${"id" in body ? body.id : other}`,
        },
      }),
    );
    try {
      await expect(call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("structure pages reject foreign rows, wrong paging and malformed DTOs", async () => {
  const valid = page([channel]);
  for (const { call, body } of [
    {
      call: () => api.listConversations(context),
      body: page([{ ...channel, org_id: other }]),
    },
    {
      call: () => api.listCategories(context),
      body: page([{ ...category, org_id: other }]),
    },
    {
      call: () => api.listMembers(context, conversationId),
      body: page([{ ...member, org_id: org }]),
    },
    {
      call: () => api.listDirectBlocks(context),
      body: page([{ ...block, blocked_user_id: "invalid" }]),
    },
    {
      call: () => api.listConversations(context),
      body: { ...valid, pagination: { ...valid.pagination, limit: 10 } },
    },
    {
      call: () => api.listConversations(context),
      body: { ...valid, pagination: { ...valid.pagination, offset: 1 } },
    },
    {
      call: () => api.listConversations(context),
      body: { ...valid, pagination: { ...valid.pagination, count: 0 } },
    },
    {
      call: () => api.listConversations(context),
      body: { ...valid, pagination: { ...valid.pagination, has_more: true } },
    },
  ]) {
    const mock = installFetch(() => Response.json(body));
    try {
      await expect(call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("structure operations refuse an undocumented success status", async () => {
  for (const row of calls().filter(
    (value) => value.name !== "existing direct",
  )) {
    const status = row.status === 204 ? 200 : 202;
    const mock = installFetch(() =>
      Response.json(row.wire, {
        status,
        headers: {
          ETag: etag,
          ...(row.location ? { Location: row.location } : {}),
        },
      }),
    );
    try {
      await expect(row.invoke()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("structure versioned resources refuse missing or weak ETags", async () => {
  for (const row of calls().filter(
    (value) =>
      value.expected &&
      typeof value.expected === "object" &&
      "etag" in value.expected,
  )) {
    const mock = installFetch(() =>
      Response.json(row.wire, {
        status: row.status,
        headers: row.location ? { Location: row.location } : {},
      }),
    );
    try {
      await expect(row.invoke()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  const mock = installFetch(() =>
    Response.json(channel, { headers: { ETag: 'W/"weak"' } }),
  );
  try {
    await expect(
      api.getConversation(context, conversationId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("structure creates require Location naming the returned resource", async () => {
  for (const row of calls().filter((value) => value.status === 201)) {
    for (const location of [
      undefined,
      "/api/comms/conversations/not-the-created-resource",
      "https://outside.invalid/other",
    ]) {
      const mock = installFetch(() =>
        Response.json(row.wire, {
          status: 201,
          headers: { ETag: etag, ...(location ? { Location: location } : {}) },
        }),
      );
      try {
        await expect(row.invoke()).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
  }
});

test("structure conditional refusals and dependency failures are propagated without retrying writes", async () => {
  for (const [status, code] of [
    [412, "comms_precondition_failed"],
    [428, "comms_precondition_required"],
    [403, "comms_capability_denied"],
    [404, "comms_not_found"],
    [409, "comms_capacity_reached"],
    [503, "comms_unavailable"],
  ] as const) {
    const mock = installFetch(() =>
      Response.json(
        { detail: { code, message: "Request refused" } },
        { status },
      ),
    );
    try {
      await expect(
        api.updateChannel(
          context,
          conversationId,
          { name: "New" },
          conditional,
        ),
      ).rejects.toMatchObject({ status, code });
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
  for (const error of [
    new TypeError("Network failed"),
    new DOMException("Cancelled", "AbortError"),
  ]) {
    const mock = installFetch(() => Promise.reject(error));
    try {
      await expect(
        api.blockDirect(context, { blocked_user_id: peer }),
      ).rejects.toBe(error);
    } finally {
      mock.restore();
    }
  }
});
