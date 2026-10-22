import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/threads-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import {
  context,
  conversationId,
  rootId,
  messageId,
  other,
  thread,
  live,
  tombstone,
  replyRequest,
  history,
  page,
} from "./s18-fixtures";

const reply = { ...live, thread };
const root = {
  ...live,
  parent_id: null,
  also_send_to_channel: false,
  thread: { ...thread, root_message_id: messageId },
};

// Every outer message remains bound correctly; only its embedded thread differs.
const refused = [
  {
    name: "reaction add with a foreign thread organization",
    call: () =>
      api.addReaction(context, conversationId, messageId, { emoji: "👍" }),
    wire: { ...reply, thread: { ...thread, org_id: other } },
  },
  {
    name: "reaction removal with a foreign thread conversation",
    call: () =>
      api.removeReaction(context, conversationId, messageId, { emoji: "👍" }),
    wire: { ...reply, thread: { ...thread, conversation_id: other } },
  },
  {
    name: "reply pin with a thread rooted outside its parent",
    call: () =>
      api.setPin(context, conversationId, messageId, { pinned: true }),
    wire: { ...reply, thread: { ...thread, root_message_id: messageId } },
  },
  {
    name: "root pin with a thread rooted at a different message",
    call: () =>
      api.setPin(context, conversationId, messageId, { pinned: true }),
    wire: { ...root, thread },
  },
  {
    name: "pin list containing a foreign thread organization",
    call: () => api.listPins(context, conversationId),
    wire: page([{ ...root, thread: { ...root.thread, org_id: other } }]),
  },
  {
    name: "reply replay with a foreign thread conversation",
    call: () => api.sendReply(context, conversationId, rootId, replyRequest),
    wire: { ...reply, thread: { ...thread, conversation_id: other } },
  },
  {
    name: "reply history containing a mismatched embedded root",
    call: () => api.getReplies(context, conversationId, rootId),
    wire: {
      ...history,
      items: [{ ...reply, thread: { ...thread, root_message_id: other } }],
    },
  },
];

for (const row of refused) {
  test(`B1 rejects ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.wire));
    try {
      await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  });
}

test("B1 pin acknowledgements preserve valid root, reply and null thread representations", async () => {
  for (const wire of [root, reply, live]) {
    const mock = installFetch(() => Response.json(wire));
    try {
      await expect(
        api.setPin(context, conversationId, messageId, { pinned: true }),
      ).resolves.toEqual(wire);
    } finally {
      mock.restore();
    }
  }
});

test("B1 current tombstone replay retains its valid parent thread", async () => {
  const message = { ...tombstone, thread };
  const mock = installFetch(() => Response.json(message));
  try {
    await expect(
      api.sendReply(context, conversationId, rootId, replyRequest),
    ).resolves.toEqual({ status: 200, message });
  } finally {
    mock.restore();
  }
});
