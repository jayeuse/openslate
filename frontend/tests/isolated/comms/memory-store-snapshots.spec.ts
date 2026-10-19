/** Snapshot store specifications authored before implementation. */
import { expect, test } from "@playwright/test";
import type { CommsEvent } from "@/components/systems/comms/contract/types";
import type {
  MemoryCommsState,
  MemoryConversation,
} from "@/components/systems/comms/memory/model";
import type { MemoryCommand } from "@/components/systems/comms/memory/store";
import {
  caught,
  fixture,
  observer,
  otherOrg,
  owner,
  renameCommand,
  topic,
} from "./memory-store-fixture";

const absentId = "72000000-0000-4000-8000-000000000099";
const rootLinkId = "72000000-0000-4000-8000-0000000000a1";
const replyLinkId = "72000000-0000-4000-8000-0000000000a2";
const additionalLinkId = "72000000-0000-4000-8000-0000000000a3";
const foreignRecordId = "72000000-0000-4000-8000-0000000000a4";

/** Explicit unknown-input fixture, usable before and after the ID20 model change. */
function recordLinkSnapshot(source: ReturnType<typeof fixture>) {
  const snapshot = structuredClone(source.store.exportSnapshot());
  const root = Object.values(snapshot.state.messages).find(
    (message) => message.parent_id === null,
  );
  const reply = Object.values(snapshot.state.messages).find(
    (message) => message.parent_id === root?.id,
  );
  const record = Object.values(snapshot.state.records)[0];
  if (!root || !reply || !record)
    throw new Error("Owned seed root, reply and catalog record are required");
  const links = {
    [root.id]: [{ id: rootLinkId, record_id: record.id }],
    [reply.id]: [{ id: replyLinkId, record_id: record.id }],
  };
  const messages = Object.fromEntries(
    Object.values(snapshot.state.messages).map((message) => [
      message.id,
      {
        ...Object.fromEntries(
          Object.entries(message).filter(
            ([key]) => key !== "record_ids" && key !== "record_links",
          ),
        ),
        record_links: links[message.id] ?? [],
      },
    ]),
  );
  Object.assign(snapshot.state.conversations[source.channelId], {
    topic: "Imported record-link topic must not be partially salvaged",
  });
  return {
    input: { ...snapshot, state: { ...snapshot.state, messages } },
    rootId: root.id,
    replyId: reply.id,
    recordId: record.id,
  };
}

test("canonical record-link snapshot preserves independent IDs across reload", () => {
  const original = fixture();
  let restored: ReturnType<typeof fixture> | undefined;
  let reloaded: ReturnType<typeof fixture> | undefined;
  try {
    const payload = recordLinkSnapshot(original);
    const input: unknown = JSON.parse(JSON.stringify(payload.input));
    restored = fixture(input, 2);
    expect(restored.store.restoration).toBe("restored");
    const exported = restored.store.exportSnapshot();
    expect(exported.state.messages[payload.rootId]).toMatchObject({
      record_links: [{ id: rootLinkId, record_id: payload.recordId }],
    });
    expect(exported.state.messages[payload.replyId]).toMatchObject({
      record_links: [{ id: replyLinkId, record_id: payload.recordId }],
    });
    expect(exported).toEqual(payload.input);
    const roundtrip: unknown = JSON.parse(JSON.stringify(exported));
    reloaded = fixture(roundtrip, 3);
    expect(reloaded.store.restoration).toBe("restored");
    expect(reloaded.store.exportSnapshot()).toEqual(payload.input);
  } finally {
    reloaded?.store.dispose();
    restored?.store.dispose();
    original.store.dispose();
  }
});

test("owned invalid graph recovers atomically: record-link relationships", async () => {
  const original = fixture();
  const payload = recordLinkSnapshot(original);
  const invalidLinks: {
    name: string;
    corrupt(input: typeof payload.input): void;
  }[] = [
    {
      name: "two messages reuse one link ID",
      corrupt(input) {
        input.state.messages[payload.replyId].record_links[0].id = rootLinkId;
      },
    },
    {
      name: "link ID collides with a catalog record ID",
      corrupt(input) {
        input.state.messages[payload.rootId].record_links[0].id =
          payload.recordId;
      },
    },
    {
      name: "link references a missing record",
      corrupt(input) {
        input.state.messages[payload.rootId].record_links[0].record_id =
          absentId;
      },
    },
    {
      name: "message repeats a record through two different links",
      corrupt(input) {
        input.state.messages[payload.rootId].record_links.push({
          id: additionalLinkId,
          record_id: payload.recordId,
        });
      },
    },
    {
      name: "link references a foreign-organization record",
      corrupt(input) {
        input.state.records[foreignRecordId] = {
          ...structuredClone(input.state.records[payload.recordId]),
          id: foreignRecordId,
          org_id: otherOrg,
        };
        input.state.messages[payload.rootId].record_links[0].record_id =
          foreignRecordId;
      },
    },
  ];
  try {
    // Prevent blanket refusal of the new representation from satisfying negatives.
    const control = fixture(structuredClone(payload.input), 2);
    try {
      expect(control.store.restoration).toBe("restored");
    } finally {
      control.store.dispose();
    }
    for (const invalid of invalidLinks) {
      await test.step(invalid.name, async () => {
        const corrupted = structuredClone(payload.input);
        invalid.corrupt(corrupted);
        const input: unknown = corrupted;
        const recovered = fixture(input, 3);
        try {
          expect(recovered.store.restoration).toBe("recovered");
          expect(recovered.store.exportSnapshot().state).toEqual(
            recovered.initial,
          );
        } finally {
          recovered.store.dispose();
        }
      });
    }
  } finally {
    original.store.dispose();
  }
});

test("owned format1 body with former record_ids recovers the whole seed", () => {
  const original = fixture();
  let recovered: ReturnType<typeof fixture> | undefined;
  try {
    const payload = recordLinkSnapshot(original);
    const messages = Object.fromEntries(
      Object.entries(payload.input.state.messages).map(([id, message]) => [
        id,
        {
          ...Object.fromEntries(
            Object.entries(message).filter(([key]) => key !== "record_links"),
          ),
          record_ids:
            id === payload.rootId || id === payload.replyId
              ? [payload.recordId]
              : [],
        },
      ]),
    );
    const input: unknown = {
      ...payload.input,
      state: { ...payload.input.state, messages },
    };
    recovered = fixture(input, 2);
    expect(recovered.store.restoration).toBe("recovered");
    expect(recovered.store.exportSnapshot().state).toEqual(recovered.initial);
  } finally {
    recovered?.store.dispose();
    original.store.dispose();
  }
});

test("owned snapshot restores the aggregate while a new instance rejects old preconditions", async () => {
  const original = fixture();
  let restored: ReturnType<typeof fixture> | undefined;
  try {
    expect(original.store.restoration).toBe("empty");
    await original.handle.command(renameCommand(original, "Saved owned topic"));
    const oldTag = original.handle.version(original.key);
    // Pass an actual serialization round trip as unknown, not a typed state cast.
    const snapshot: unknown = JSON.parse(
      JSON.stringify(original.store.exportSnapshot()),
    );
    restored = fixture(snapshot, 2);
    expect(restored.store.restoration).toBe("restored");
    expect(topic(restored.handle, restored.channelId)).toBe(
      "Saved owned topic",
    );
    expect(restored.store.exportSnapshot()).toEqual(
      original.store.exportSnapshot(),
    );
    expect(restored.handle.version(restored.key)).not.toBe(oldTag);
    await expect(
      restored.handle.command(
        renameCommand(restored, "Stale instance write", oldTag),
      ),
    ).rejects.toMatchObject({ kind: "http", failure: { status: 412 } });
    await restored.handle.command(
      renameCommand(restored, "Changed only in restored instance"),
    );
    expect(topic(original.handle, original.channelId)).toBe(
      "Saved owned topic",
    );
    expect(topic(restored.handle, restored.channelId)).toBe(
      "Changed only in restored instance",
    );
  } finally {
    restored?.store.dispose();
    original.store.dispose();
  }
});

test("constructor, reads, outputs and saved drafts cannot mutate canonical or reset state by alias", async () => {
  const f = fixture();
  const initial = structuredClone(f.store.exportSnapshot());
  const retainedDrafts: MemoryCommsState[] = [];
  try {
    Object.assign(f.initial.conversations[f.channelId], {
      topic: "Changed constructor argument",
    });
    f.initial.people[owner.user_id].group_ids.length = 0;
    const projection = f.handle.read(
      (state) => state.conversations[f.channelId],
    );
    caught(() => Object.assign(projection, { topic: "Changed read result" }));
    caught(() =>
      f.handle.read((state) => {
        state.people[owner.user_id].display_name = "Changed inside projector";
        return state.people[owner.user_id].display_name;
      }),
    );
    const exported = f.store.exportSnapshot();
    caught(() => {
      exported.state.people[owner.user_id].group_ids.length = 0;
    });
    caught(() =>
      Object.assign(exported.state.conversations[f.channelId], {
        topic: "Changed exported snapshot",
      }),
    );
    expect(f.store.exportSnapshot()).toEqual(initial);

    const base = renameCommand(f, "Accepted clone boundary");
    const command: MemoryCommand<void, MemoryConversation> = {
      ...base,
      authorize(current, execution, prepared) {
        base.authorize(current, execution, prepared);
        // Detached authority input is not another write path.
        caught(() => {
          current.people[owner.user_id].display_name =
            "Changed inside authority callback";
        });
      },
      apply(draft, execution, prepared) {
        retainedDrafts.push(draft);
        const outcome = base.apply(draft, execution, prepared);
        return { ...outcome, value: draft.conversations[f.channelId] };
      },
    };
    const result = await f.handle.command(command);
    const acceptedTag = f.handle.version(f.key);
    expect(result.value).toMatchObject({ topic: "Accepted clone boundary" });
    expect(retainedDrafts).toHaveLength(1);
    caught(() =>
      Object.assign(result.value, { topic: "Changed command result" }),
    );
    caught(() =>
      Object.assign(retainedDrafts[0].conversations[f.channelId], {
        topic: "Changed retained draft",
      }),
    );
    expect(topic(f.handle, f.channelId)).toBe("Accepted clone boundary");
    expect(f.handle.version(f.key)).toBe(acceptedTag);
    expect(
      f.handle.read((state) => state.people[owner.user_id].display_name),
    ).toBe("Test owner");
    f.store.reset();
    expect(f.store.exportSnapshot()).toEqual(initial);
  } finally {
    f.store.dispose();
  }
});

test("each event observer receives its own normalized IDs-only value", async () => {
  const f = fixture();
  const later: CommsEvent[] = [];
  f.handle.events.subscribe({
    ...observer([]),
    on_event: (event) => {
      Object.assign(event.payload, { body: "Untrusted observer mutation" });
      event.topic = "not a context-bound topic";
    },
  });
  f.handle.events.subscribe(observer(later));
  try {
    await f.handle.command(
      renameCommand(f, "Accepted before event alias attempt"),
    );
    expect(later).toEqual([
      {
        event: "structure",
        private: true,
        topic: `org:${owner.org_id}:user:${owner.user_id}`,
        payload: {},
      },
    ]);
    expect(topic(f.handle, f.channelId)).toBe(
      "Accepted before event alias attempt",
    );
  } finally {
    f.store.dispose();
  }
});

for (const ownership of [
  "other organization",
  "other user",
  "legacy unowned",
] as const) {
  test(`inner snapshot from ${ownership} is refused without adopting its content`, async () => {
    const original = fixture();
    let refused: ReturnType<typeof fixture> | undefined;
    try {
      await original.handle.command(
        renameCommand(original, "Content from another owner"),
      );
      const snapshot = structuredClone(original.store.exportSnapshot());
      let input: unknown = snapshot;
      if (ownership === "other organization")
        snapshot.owner = { ...owner, org_id: otherOrg };
      if (ownership === "other user")
        snapshot.owner = { ...owner, user_id: original.adminId };
      if (ownership === "legacy unowned") input = snapshot.state;
      refused = fixture(input, 2);
      expect(refused.store.restoration).toBe("refused_owner");
      expect(refused.store.exportSnapshot().state).toEqual(refused.initial);
      expect(topic(refused.handle, refused.channelId)).toBe(
        "Daily coordination, handovers, and field updates.",
      );
    } finally {
      refused?.store.dispose();
      original.store.dispose();
    }
  });
}

type Corruption = {
  name: string;
  apply(state: MemoryCommsState, channelId: string): void;
};
const corruptions: Corruption[] = [
  {
    name: "map key disagrees with entity identity",
    apply: (state, channelId) => {
      state.conversations[channelId].id = absentId;
    },
  },
  {
    name: "same-key person belongs to another organization",
    apply: (state) => {
      state.people[owner.user_id].org_id = otherOrg;
    },
  },
  {
    name: "reply points to a root in another conversation",
    apply(state, channelId) {
      const reply = Object.values(state.messages).find(
        (message) => message.parent_id !== null,
      );
      if (!reply) throw new Error("Seed reply is required for this corruption");
      state.conversations[absentId] = {
        ...state.conversations[channelId],
        id: absentId,
      };
      state.members[absentId] = structuredClone(state.members[channelId]);
      state.high_water_seq[absentId] = 1;
      reply.conversation_id = absentId;
      reply.seq = 1;
    },
  },
  {
    name: "thread starter disagrees with its root author",
    apply(state) {
      const thread = Object.values(state.threads)[0];
      if (!thread)
        throw new Error("Seed thread is required for this corruption");
      thread.starter_id = owner.user_id;
    },
  },
  {
    name: "two messages reuse a conversation sequence",
    apply(state) {
      const reply = Object.values(state.messages).find(
        (message) => message.parent_id !== null,
      );
      if (!reply) throw new Error("Seed reply is required for this corruption");
      reply.seq = 1;
    },
  },
  {
    name: "high water is behind retained messages",
    apply: (state, channelId) => {
      state.high_water_seq[channelId] = 0;
    },
  },
  {
    name: "resource version is not a valid counter",
    apply: (state, channelId) => {
      state.resource_versions[`conversation:${channelId}`] = -1;
    },
  },
  {
    name: "stored owner attempts to replace the admitted role",
    apply: (state) => {
      state.people[owner.user_id].role = "admin";
    },
  },
  {
    name: "legacy authority fields survive in an otherwise valid person",
    apply: (state) => {
      Object.assign(state.people[owner.user_id], {
        permissions: { manageWorkspace: true },
      });
    },
  },
  {
    name: "runtime bytes are attached to serialized state",
    apply: (state) => {
      Object.assign(state, { local_file_bytes: new Uint8Array([1, 2, 3]) });
    },
  },
];

for (const corruption of corruptions) {
  test(`owned invalid graph recovers atomically: ${corruption.name}`, async () => {
    const original = fixture();
    let recovered: ReturnType<typeof fixture> | undefined;
    try {
      await original.handle.command(
        renameCommand(original, "Do not partially salvage this topic"),
      );
      const snapshot = structuredClone(original.store.exportSnapshot());
      corruption.apply(snapshot.state, original.channelId);
      recovered = fixture(snapshot, 2);
      expect(recovered.store.restoration).toBe("recovered");
      expect(recovered.store.exportSnapshot().state).toEqual(recovered.initial);
      expect(topic(recovered.handle, recovered.channelId)).toBe(
        "Daily coordination, handovers, and field updates.",
      );
      await recovered.handle.command(
        renameCommand(recovered, "Usable after recovery"),
      );
      expect(topic(recovered.handle, recovered.channelId)).toBe(
        "Usable after recovery",
      );
    } finally {
      recovered?.store.dispose();
      original.store.dispose();
    }
  });
}

test("valid sparse high water and private deleted-root material survive canonical restoration", () => {
  const original = fixture();
  let restored: ReturnType<typeof fixture> | undefined;
  try {
    const snapshot = structuredClone(original.store.exportSnapshot());
    const root = Object.values(snapshot.state.messages).find(
      (message) => message.parent_id === null,
    );
    if (!root) throw new Error("Seed root is required for this case");
    root.deleted_at = "2026-10-19T04:00:00Z";
    snapshot.state.high_water_seq[original.channelId] = 9; // Purged gaps are legal; never infer max(seq).
    restored = fixture(snapshot, 2);
    expect(restored.store.restoration).toBe("restored");
    expect(restored.store.exportSnapshot()).toEqual(snapshot);
    const accepted = structuredClone(snapshot);
    root.body = "Changed caller-owned restoration input";
    snapshot.state.high_water_seq[original.channelId] = 0;
    expect(restored.store.exportSnapshot()).toEqual(accepted);
    // These are internal persistence assertions, not permission to expose deleted body in client reads.
    expect(restored.store.exportSnapshot().state.messages[root.id].body).toBe(
      "Two vans are loaded. The spare tool kit is beside dispatch.",
    );
  } finally {
    restored?.store.dispose();
    original.store.dispose();
  }
});
