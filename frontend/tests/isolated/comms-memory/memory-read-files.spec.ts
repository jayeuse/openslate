/** Promoted before implementation; local Blob/state journeys, UNRUN / UNTYPECHECKED. */
import { expect, test } from "@playwright/test";
import { hideInNewDepartment } from "../../support/comms-memory/memory/seed";
import { createMemoryFileResources } from "../../support/comms-memory/memory/files";
import { createMessageFamily } from "../../support/comms-memory/memory/messages";
import { createOperationalResources } from "../../support/comms-memory/memory/operational-resources";
import {
  changeAuthority,
  collect,
  deferred,
  fixture,
  httpFailure,
  id,
  owner,
  png,
  preferences,
  seedMessage,
  setup,
  time,
} from "./memory-message-fixture";

test("read summaries exclude own/deleted/hidden content and reminders never fabricate unread", async () => {
  const s = setup();
  seedMessage(s, 200, 2, {
    body: "Old mention",
    mention_user_ids: [owner.user_id],
  });
  seedMessage(s, 201, 5, { author_id: owner.user_id });
  seedMessage(s, 202, 9, {
    deleted_at: time,
    mention_user_ids: [owner.user_id],
  });
  seedMessage(s, 203, 1, {
    conversation_id: s.hiddenId,
    mention_user_ids: [owner.user_id],
  });
  s.initial.users[owner.user_id].last_read_seq[s.channelId] = 9;
  s.initial.users[owner.user_id].conversations[s.channelId] = {
    ...preferences,
    manual_unread: true,
  };
  // Direct parity is data in the same world, not a second read-count implementation.
  const directId = id(204);
  s.initial.conversations[directId] = {
    id: directId,
    org_id: owner.org_id,
    kind: "direct",
    creator_id: s.peerId,
    created_at: time,
    updated_at: time,
    archived_at: null,
  };
  s.initial.members[directId] = {
    [owner.user_id]: s.initial.members[s.channelId][owner.user_id],
    [s.peerId]: s.initial.members[s.channelId][s.peerId],
  };
  seedMessage(s, 205, 4, {
    conversation_id: directId,
    mention_user_ids: [owner.user_id],
  });
  seedMessage(s, 206, 8, {
    conversation_id: directId,
    author_id: owner.user_id,
  });
  const f = fixture(s);
  try {
    const before = f.store.exportSnapshot();
    expect(f.summary()).toMatchObject({
      last_read_seq: 9,
      high_water_seq: 9,
      unread_count: 0,
      mention_count: 0,
      first_unread_seq: null,
      preferences: { manual_unread: true },
    });
    await f.as().getHistory(f.channelId);
    expect(f.summary().preferences.manual_unread).toBe(true);
    expect(f.store.exportSnapshot()).toEqual(before); // No GET/refetch auto-acknowledgement.
    expect(f.summary(directId)).toMatchObject({
      unread_count: 1,
      mention_count: 1,
      first_unread_seq: 4,
      high_water_seq: 8,
    });
    await f.as(f.peerId).sendMessage(f.channelId, {
      client_key: id(207),
      body: "New mention",
      mention_user_ids: [owner.user_id],
    });
    await f.as().sendMessage(f.channelId, {
      client_key: id(208),
      body: "Own update",
      mention_user_ids: [owner.user_id],
    });
    expect(f.summary()).toMatchObject({
      unread_count: 1,
      mention_count: 1,
      first_unread_seq: 10,
      high_water_seq: 11,
    });
    await Promise.all([
      f.as().markRead(f.channelId, { last_read_seq: 10 }),
      f.as().markRead(f.channelId, { last_read_seq: 2 }),
    ]);
    expect(f.summary()).toMatchObject({
      last_read_seq: 10,
      unread_count: 0,
      mention_count: 0,
      first_unread_seq: null,
      preferences: { manual_unread: false },
    });
    expect(await f.as().markRead(f.channelId, { last_read_seq: 999 })).toEqual({
      conversation_id: f.channelId,
      last_read_seq: 11,
    });
    expect(await f.as().markRead(directId, { last_read_seq: 999 })).toEqual({
      conversation_id: directId,
      last_read_seq: 8,
    });
    expect(f.summary(directId)).toMatchObject({
      unread_count: 0,
      mention_count: 0,
      first_unread_seq: null,
    });
    expect(() => f.summary(f.hiddenId)).toThrow("refused");
    await httpFailure(
      f.as().markRead(f.hiddenId, { last_read_seq: 1 }),
      404,
      "comms_not_found",
    );
  } finally {
    f.close();
  }
});

test("read counts saturate at 100 but use real remaining messages when marking read", async () => {
  const s = setup();
  // Fixed-size homogeneous fixture, not a second filter/count oracle.
  for (let n = 1; n <= 102; n++)
    seedMessage(s, 300 + n, n, { mention_user_ids: [owner.user_id] });
  seedMessage(s, 450, 103, {
    author_id: owner.user_id,
    mention_user_ids: [owner.user_id],
  });
  seedMessage(s, 451, 104, {
    deleted_at: time,
    mention_user_ids: [owner.user_id],
  });
  const f = fixture(s);
  try {
    expect(f.summary()).toMatchObject({
      unread_count: 100,
      mention_count: 100,
      first_unread_seq: 1,
      high_water_seq: 104,
    });
    await f.as().markRead(f.channelId, { last_read_seq: 3 });
    expect(f.summary()).toMatchObject({
      unread_count: 99,
      mention_count: 99,
      first_unread_seq: 4,
    });
    await f.as().markRead(f.channelId, { last_read_seq: 104 });
    expect(f.summary()).toMatchObject({
      unread_count: 0,
      mention_count: 0,
      first_unread_seq: null,
    });
  } finally {
    f.close();
  }
});

test("reserved bytes become a ready attachment and download locally, never from a restored metadata-only snapshot", async () => {
  const f = fixture();
  let restored: ReturnType<typeof fixture> | undefined;
  let replacement: ReturnType<typeof createMemoryFileResources> | undefined;
  let replacementResources:
    ReturnType<typeof createOperationalResources> | undefined;
  try {
    const bytes = png();
    const reserved = await f.as().reserveAttachment(f.channelId, {
      filename: "pixel.png",
      expected_size: bytes.size,
    });
    expect(reserved).toMatchObject({
      state: "awaiting_upload",
      actual_size: null,
      creator_id: owner.user_id,
    });
    const beforeSend = f.store.exportSnapshot();
    await httpFailure(
      f.as().sendMessage(f.channelId, {
        client_key: id(500),
        body: "Not ready",
        attachment_ids: [reserved.id],
      }),
      422,
      "comms_invalid_input",
    );
    expect(f.store.exportSnapshot()).toEqual(beforeSend);
    const progress: { loaded_bytes: number; total_bytes: number }[] = [];
    const peer = f.as(f.peerId);
    const observed: {
      state: string;
      download: ReturnType<typeof peer.downloadAttachment>;
    }[] = [];
    const stop = f.store.subscribe(() => {
      const row = f.store.exportSnapshot().state.files[reserved.id];
      // Start the real byte read during notification, not after upload resolves.
      const download = peer.downloadAttachment(f.channelId, reserved.id);
      void download.catch(() => undefined); // Retain rejection for assertion outside observer isolation.
      observed.push({ state: row.state, download });
    });
    const ready = await f
      .as()
      .uploadAttachment(f.channelId, reserved.id, bytes, {
        on_progress: (p) => {
          progress.push(p);
        },
      })
      .finally(stop);
    expect(observed.map((entry) => entry.state)).toEqual(["ready"]);
    const fromObserver = await Promise.all(
      observed.map((entry) => entry.download),
    );
    expect(fromObserver).toHaveLength(1);
    expect(fromObserver[0]).toMatchObject({
      filename: "pixel.png",
      media_type: "image/png",
    });
    expect(new Uint8Array(await fromObserver[0].bytes.arrayBuffer())).toEqual(
      new Uint8Array(await bytes.arrayBuffer()),
    );
    expect(ready).toMatchObject({
      id: reserved.id,
      state: "ready",
      actual_size: bytes.size,
      media_type: "image/png",
    });
    expect(progress.at(-1)).toEqual({
      loaded_bytes: bytes.size,
      total_bytes: bytes.size,
    });
    expect(
      progress.every(
        (p, index) =>
          p.loaded_bytes >= 0 &&
          p.loaded_bytes <= bytes.size &&
          p.total_bytes === bytes.size &&
          (index === 0 || p.loaded_bytes >= progress[index - 1].loaded_bytes),
      ),
    ).toBe(true);
    await httpFailure(
      f.as().sendMessage(f.otherChannelId, {
        client_key: id(501),
        body: "Wrong conversation",
        attachment_ids: [ready.id],
      }),
      422,
      "comms_invalid_input",
    );
    const sent = await f.as().sendMessage(f.channelId, {
      client_key: id(500),
      body: "Now ready",
      attachment_ids: [ready.id],
    });
    expect(sent.message).toMatchObject({
      attachments: [{ id: ready.id, filename: "pixel.png", size: bytes.size }],
    });
    const downloaded = await f
      .as(f.peerId)
      .downloadAttachment(f.channelId, ready.id);
    expect(downloaded.bytes).toBeInstanceOf(Blob);
    expect(new Uint8Array(await downloaded.bytes.arrayBuffer())).toEqual(
      new Uint8Array(await bytes.arrayBuffer()),
    );
    expect(Object.keys(downloaded).sort()).toEqual([
      "bytes",
      "filename",
      "media_type",
    ]);
    expect(downloaded.filename).toBe("pixel.png");
    expect(downloaded.media_type).toBe("image/png");
    const snapshot = f.store.exportSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain("blob:");
    restored = fixture(setup(), snapshot, 2);
    await httpFailure(
      restored.as().downloadAttachment(f.channelId, ready.id),
      404,
      "file_not_found",
    );
    // D44 access loss: the owner's department role ends, the peer keeps one.
    await changeAuthority(f, (draft) => {
      hideInNewDepartment(draft, f.channelId, id(1100));
      draft.people[f.peerId].department_levels[id(1100)] = "write";
    });
    await expect(
      f.as().downloadAttachment(f.channelId, ready.id),
    ).rejects.toMatchObject({ kind: "http", failure: { status: 404 } });
    expect(
      (await f.as(f.peerId).downloadAttachment(f.channelId, ready.id)).bytes
        .size,
    ).toBe(bytes.size);
    // Explicit resource disposal clears bytes/proofs, not merely the calling handle.
    f.files.dispose();
    f.files.dispose();
    replacement = createMemoryFileResources(f.store);
    // Fresh real resources have no bytes; presence is not a download dependency.
    replacementResources = createOperationalResources(f.store, {
      files: replacement,
      clock: f.clock,
      ownerBinding: f.binding(),
    });
    const peerHandle = f.handle(f.peerId);
    const dependencies = replacementResources.sendDependenciesFor(peerHandle);
    const withoutBytes = createMessageFamily(
      { handle: peerHandle, authority: dependencies.authority },
      dependencies,
    );
    await httpFailure(
      withoutBytes.downloadAttachment(f.channelId, ready.id),
      404,
      "file_not_found",
    );
  } finally {
    replacementResources?.dispose();
    replacement?.dispose();
    restored?.close();
    f.close();
  }
});

test("failed byte commit is not downloadable and the same reservation can retry", async () => {
  const f = fixture();
  const { events } = collect(f);
  try {
    const bytes = png();
    const retained = await f.as(f.peerId).reserveAttachment(f.channelId, {
      filename: "retained.png",
      expected_size: bytes.size,
    });
    await f.as(f.peerId).uploadAttachment(f.channelId, retained.id, bytes);
    const reserved = await f.as().reserveAttachment(f.channelId, {
      filename: "retry.png",
      expected_size: bytes.size,
    });
    const before = f.store.exportSnapshot();
    const eventCount = events.length;
    f.store.failNextCommit();
    await httpFailure(
      f.as().uploadAttachment(f.channelId, reserved.id, bytes),
      503,
      "comms_unavailable",
    );
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toHaveLength(eventCount);
    await httpFailure(
      f.as().downloadAttachment(f.channelId, reserved.id),
      404,
      "file_not_found",
    );
    const stillCommitted = await f
      .as(f.peerId)
      .downloadAttachment(f.channelId, retained.id);
    expect(stillCommitted).toMatchObject({
      filename: "retained.png",
      media_type: "image/png",
    });
    expect(new Uint8Array(await stillCommitted.bytes.arrayBuffer())).toEqual(
      new Uint8Array(await bytes.arrayBuffer()),
    );
    expect(
      (await f.as().uploadAttachment(f.channelId, reserved.id, bytes)).state,
    ).toBe("ready");
    expect(
      (await f.as().downloadAttachment(f.channelId, reserved.id)).bytes.size,
    ).toBe(bytes.size);
  } finally {
    f.close();
  }
});

class HeldBlob extends Blob {
  readonly entered = deferred<void>();
  readonly release = deferred<void>();
  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.entered.resolve();
    await this.release.promise;
    return super.arrayBuffer();
  }
}

for (const ending of ["abort", "dispose"] as const) {
  test(`${ending} during byte preparation discards late bytes and readiness`, async () => {
    const f = fixture();
    const held = new HeldBlob([png()], { type: "image/png" });
    try {
      const reserved = await f.as().reserveAttachment(f.channelId, {
        filename: "held.png",
        expected_size: held.size,
      });
      const before = f.store.exportSnapshot();
      const { events } = collect(f);
      const controller = new AbortController();
      const pending = f.as().uploadAttachment(f.channelId, reserved.id, held, {
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        kind: "cancelled",
      });
      await held.entered.promise;
      if (ending === "abort") controller.abort();
      else f.files.dispose();
      await rejected; // Must settle while Blob preparation is still held.
      held.release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.store.exportSnapshot()).toEqual(before);
      expect(events).toEqual([]);
      f.files.dispose();
      const freshFiles = createMemoryFileResources(f.store);
      let freshResources:
        ReturnType<typeof createOperationalResources> | undefined;
      try {
        // Use real replacement ownership, not a dependency spread around retired files.
        freshResources = createOperationalResources(f.store, {
          files: freshFiles,
          clock: f.clock,
          ownerBinding: f.binding(),
        });
        await httpFailure(
          createMessageFamily(
            f.binding(),
            freshResources.sendDependencies,
          ).downloadAttachment(f.channelId, reserved.id),
          404,
          "file_not_found",
        );
      } finally {
        freshResources?.dispose();
        freshFiles.dispose();
      }
    } finally {
      held.release.resolve();
      f.close();
    }
  });
}

test("record cards recheck module access on every projection and expose only an opaque link when lost", async () => {
  const f = fixture();
  try {
    const original = {
      client_key: id(510),
      body: "Visit reference",
      record_ids: [f.recordId],
    };
    const sent = await f.as().sendMessage(f.channelId, original);
    if (sent.message.state !== "live")
      throw new Error("New message must be live");
    const card = sent.message.record_references[0];
    expect(card).toMatchObject({
      state: "available",
      record_id: f.recordId,
      title: "Riverside service visit",
    });
    expect(card.id).not.toBe(f.recordId);
    expect(await f.as().getRecordReference(f.channelId, card.id)).toEqual(card);
    await changeAuthority(f, (draft) => {
      draft.people[owner.user_id].readable_module_ids = [];
    });
    const unavailable = { id: card.id, state: "unavailable" };
    expect(await f.as().getRecordReference(f.channelId, card.id)).toEqual(
      unavailable,
    );
    expect((await f.as().listLinkedRecords()).items).toEqual([unavailable]);
    const message = await f.as().getMessage(f.channelId, sent.message.id);
    expect(message.data).toMatchObject({ record_references: [unavailable] });
    expect(JSON.stringify(message.data)).not.toContain(f.recordId);
    expect(JSON.stringify(message.data)).not.toContain("Riverside");
    expect(JSON.stringify(message.data)).not.toContain("In progress");
    expect(await f.as().sendMessage(f.channelId, original)).toMatchObject({
      status: 200,
      message: { id: sent.message.id, record_references: [unavailable] },
    });
    // Another bound reader still has current module access; no cross-user card cache.
    expect(
      await f.as(f.peerId).getRecordReference(f.channelId, card.id),
    ).toEqual(card);
    await changeAuthority(f, (draft) => {
      hideInNewDepartment(draft, f.channelId, id(1100));
    });
    await httpFailure(
      f.as().getRecordReference(f.channelId, card.id),
      404,
      "comms_not_found",
    );
    expect((await f.as().listLinkedRecords()).items).toEqual([]);
  } finally {
    f.close();
  }
});
