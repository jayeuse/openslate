import { expect, test } from "@playwright/test";
import { createMemorySeed } from "@/components/systems/comms/memory/seed";
import { createMemoryCommsRuntime } from "@/components/systems/comms/adapters/memory-client";

test("direct candidate reads reuse current eligibility without membership rows and never grant a hidden or guest write", async () => {
  const owner = {
    user_id: "77000000-0000-4000-8000-000000000001",
    org_id: "77000000-0000-4000-8000-000000000002",
  };
  const initial = createMemorySeed(owner, {
    role: "member",
    display_name: "Reader",
  });
  for (const [id, room] of Object.entries(initial.conversations)) {
    if (room.kind === "channel")
      initial.conversations[id] = {
        ...room,
        scope: "groups",
        access: [
          {
            subject: "group",
            group_id: Object.keys(initial.groups)[0],
            level: "read",
          },
        ],
      };
    initial.members[id] = {};
  }
  const hiddenId = "77000000-0000-4000-8000-000000000003";
  initial.people[hiddenId] = {
    ...initial.people[owner.user_id],
    user_id: hiddenId,
    display_name: "Hidden",
    group_ids: [],
    department_levels: {},
  };
  const guest = Object.values(initial.people).find(
    (person) => person.role === "guest",
  )!;
  const runtime = createMemoryCommsRuntime({ owner, initial });
  const client = runtime.client;
  try {
    const before = runtime.exportSnapshot();
    const choices = await client.listDirectCandidates();
    expect(choices.items.map((person) => person.display_name)).toEqual([
      "Noah Tan",
      "Sofia Garcia",
    ]);
    expect(
      (await client.listDirectCandidates({ search: "sofia", limit: 1 })).items,
    ).toEqual([choices.items[1]]);
    expect(runtime.exportSnapshot()).toEqual(before);
    for (const recipient_id of [hiddenId, guest.user_id])
      await expect(
        client.findOrCreateDirect({ recipient_id }),
      ).rejects.toMatchObject({ kind: "http", failure: { status: 403 } });
    const ticket = runtime.suspendAdmission();
    expect(
      runtime.acceptAdmission(ticket, {
        context: owner,
        role: "guest",
        display_name: "Reader",
      }),
    ).toBe(true);
    expect((await runtime.client.listDirectCandidates()).items).toEqual([]);
    await expect(
      runtime.client.createGroup({
        participant_ids: [
          owner.user_id,
          ...choices.items.map((person) => person.user_id),
        ],
      }),
    ).rejects.toMatchObject({ kind: "http", failure: { status: 403 } });
    await expect(client.listDirectCandidates()).rejects.toMatchObject({
      kind: "cancelled",
    });
  } finally {
    runtime.dispose();
  }
});
