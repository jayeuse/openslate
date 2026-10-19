import { expect, test } from "@playwright/test";
import {
  createMemoryCommsClient,
  createMemoryCommsRuntime,
} from "@/components/systems/comms/adapters/memory-client";
import { createLazyProtectedTools } from "@/components/systems/comms/memory/lazy-protected-tools";
import { createMemorySeed } from "@/components/systems/comms/memory/seed";
import {
  changeAuthority,
  fixture,
  id,
  owner,
  seedMessage,
  setup,
} from "./memory-message-fixture";
import type { CommsNotification } from "@/components/systems/comms/contract/types";

test("Activity filters the bound user's unreadable and deleted sources before stable paging and never mutates notifications", async () => {
  const s = setup();
  const first = seedMessage(s, 900, 1);
  const second = seedMessage(s, 901, 2);
  const hidden = seedMessage(s, 902, 1, { conversation_id: s.hiddenId });
  const removed = seedMessage(s, 903, 3, { deleted_at: first.created_at });
  const notice = (n: number, message: typeof first): CommsNotification => ({
    id: id(n),
    org_id: owner.org_id,
    subject_type: "comms_message",
    subject_id: message.id,
    kind: "comms-mention",
    conversation_id: message.conversation_id,
    message_id: message.id,
    status: "unread",
    scheduled_for: null,
    created_at: first.created_at,
    read_at: null,
  });
  s.initial.users[owner.user_id].notifications = [
    notice(1002, second),
    notice(1000, hidden),
    notice(999, removed),
    notice(1001, first),
  ];
  s.initial.users[s.peerId].notifications = [notice(998, first)];
  const f = fixture(s);
  const protectedTools = createLazyProtectedTools({
    store: f.store,
    files: f.files,
    clock: f.clock,
  });
  const client = createMemoryCommsClient({
    binding: f.binding(),
    operational: f.controls,
    protectedTools,
  });
  try {
    const before = f.store.exportSnapshot();
    const page = await client.listActivity({ limit: 1 });
    expect(page.items.map((row) => row.id)).toEqual([id(1001)]);
    expect(page.pagination).toMatchObject({ total: 2, has_more: true });
    expect(
      (await client.listActivity({ limit: 1, offset: 1 })).items.map(
        (row) => row.id,
      ),
    ).toEqual([id(1002)]);
    expect(
      (await client.listActivity({ sort_order: "desc" })).items.map(
        (row) => row.id,
      ),
    ).toEqual([id(1002), id(1001)]);
    expect(f.store.exportSnapshot()).toEqual(before);
    await f.as(f.managerId).deleteMessage(f.channelId, first.id);
    expect((await client.listActivity()).items.map((row) => row.id)).toEqual([
      id(1002),
    ]);
    await changeAuthority(f, (draft) => {
      const room = draft.conversations[f.channelId];
      if (room.kind === "channel") {
        draft.conversations[f.channelId] = {
          ...room,
          scope: "groups",
          access: [],
        };
      }
    });
    expect((await client.listActivity()).items).toEqual([]);
    await changeAuthority(f, (draft) => {
      draft.people[owner.user_id].active = false;
    });
    await expect(client.listActivity()).rejects.toMatchObject({
      kind: "http",
      failure: { status: 404 },
    });
  } finally {
    protectedTools.dispose();
    f.close();
  }
});

test("Activity is organization-bound for the same account and refuses cancelled or retired reads", async () => {
  const runtimes = [owner.org_id, id(99)].map((org_id) => {
    const context = { ...owner, org_id };
    const initial = createMemorySeed(context, {
      role: "member",
      display_name: "Reader",
    });
    const message = Object.values(initial.messages)[0];
    initial.users[owner.user_id].notifications = [
      {
        id: id(1000),
        org_id,
        subject_type: "comms_message",
        subject_id: message.id,
        kind: "comms-mention",
        conversation_id: message.conversation_id,
        message_id: message.id,
        status: "unread",
        scheduled_for: null,
        created_at: message.created_at,
        read_at: null,
      },
    ];
    return createMemoryCommsRuntime({ owner: context, initial });
  });
  try {
    for (const [index, org] of [owner.org_id, id(99)].entries()) {
      const client = runtimes[index].client;
      expect(
        (await client.listActivity()).items.map((item) => item.org_id),
      ).toEqual([org]);
      await expect(
        client.listActivity({}, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ kind: "cancelled" });
      runtimes[index].dispose();
      await expect(client.listActivity()).rejects.toMatchObject({
        kind: "cancelled",
      });
    }
  } finally {
    runtimes.forEach((runtime) => runtime.dispose());
  }
});
