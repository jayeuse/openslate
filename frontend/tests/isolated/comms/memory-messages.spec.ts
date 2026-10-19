/** Promoted before implementation; accepted journeys plus ID25, UNRUN / UNTYPECHECKED. */
import { expect, test } from "@playwright/test";
import { messageRemovalCommand } from "@/components/systems/comms/memory/message-transitions";
import {
  changeAuthority,
  collect,
  created,
  edit,
  fixture,
  httpFailure,
  id,
  owner,
  seedMessage,
  seedThread,
  setup,
  upload,
} from "./memory-message-fixture";

test("root and reply sends share one sequence and also-send is one entity", async () => {
  const f = fixture();
  const { events } = collect(f);
  try {
    const root = await f
      .as()
      .sendMessage(f.channelId, { client_key: id(100), body: "Root" });
    const [next, reply] = await Promise.all([
      f
        .as()
        .sendMessage(f.channelId, { client_key: id(101), body: "Next root" }),
      f.as(f.peerId).sendReply(f.channelId, root.message.id, {
        client_key: id(102),
        body: "Shared reply",
        also_send_to_channel: true,
      }),
    ]);
    expect([next.message.seq, reply.message.seq].sort((a, b) => a - b)).toEqual(
      [2, 3],
    );
    const history = await f.as().getHistory(f.channelId);
    expect(history.items.map((m) => m.seq)).toEqual([1, 2, 3]);
    const replies = await f.as().getReplies(f.channelId, root.message.id);
    expect(replies.items.map((m) => m.id)).toEqual([reply.message.id]);
    expect(history.items.find((m) => m.id === reply.message.id)).toEqual(
      replies.items[0],
    );
    expect(
      (await f.as().getMessageBySequence(f.channelId, reply.message.seq)).data
        .id,
    ).toBe(reply.message.id);
    expect(history.pagination.high_water_seq).toBe(3);
    expect(created(events).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  } finally {
    f.close();
  }
});

test("replay fingerprints the original canonical sets, not the edited body", async () => {
  const f = fixture();
  const { events } = collect(f);
  try {
    const files = [await upload(f, "a.png"), await upload(f, "b.png")];
    const original = {
      client_key: id(110),
      body: "Original handover",
      mention_user_ids: [f.peerId, f.managerId],
      attachment_ids: files.map((file) => file.id),
      record_ids: [f.recordId, f.secondRecordId],
    };
    const first = await f.as().sendMessage(f.channelId, original);
    expect(
      f.store
        .exportSnapshot()
        .state.users[f.peerId].notifications.filter(
          (n) =>
            n.kind === "comms-mention" && n.message_id === first.message.id,
        ),
    ).toHaveLength(1);
    const version = await f.as().getMessage(f.channelId, first.message.id);
    await f
      .as()
      .editMessage(f.channelId, first.message.id, edit("Edited handover"), {
        if_match: version.etag,
      });
    const notificationsBeforeReplay =
      f.store.exportSnapshot().state.users[f.peerId].notifications;
    const replay = await f.as().sendMessage(f.channelId, {
      ...original,
      mention_user_ids: [...original.mention_user_ids].reverse(),
      attachment_ids: [...original.attachment_ids].reverse(),
      record_ids: [...original.record_ids].reverse(),
      mentions_channel: false,
      mentions_here: false,
      reply_to_id: null,
    });
    expect(first.status).toBe(201);
    expect(replay).toMatchObject({
      status: 200,
      message: { id: first.message.id, body: "Edited handover" },
    });
    expect(created(events)).toEqual([1]);
    expect(
      f.store.exportSnapshot().state.users[f.peerId].notifications,
    ).toEqual(notificationsBeforeReplay);
    const before = f.store.exportSnapshot();
    const eventCount = events.length;
    // One replay-conflict class; each payload component must participate, including destination/root.
    for (const changed of [
      { ...original, body: "Edited handover" },
      { ...original, mention_user_ids: [f.peerId] },
      { ...original, attachment_ids: [files[0].id] },
      { ...original, record_ids: [f.recordId] },
    ])
      await httpFailure(
        f.as().sendMessage(f.channelId, changed),
        409,
        "comms_idempotency_mismatch",
      );
    await httpFailure(
      f.as().sendReply(f.channelId, first.message.id, original),
      409,
      "comms_idempotency_mismatch",
    );
    await httpFailure(
      f.as().sendMessage(f.otherChannelId, original),
      409,
      "comms_idempotency_mismatch",
    );
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toHaveLength(eventCount);
    // Same UUID key is independent for another author, without a global key cache.
    const peer = await f.as(f.peerId).sendMessage(f.channelId, {
      client_key: original.client_key,
      body: "Peer's own message",
    });
    expect(peer.status).toBe(201);
    expect(peer.message.seq).toBe(2);
  } finally {
    f.close();
  }
});

for (const failure of ["abort", "fail-next"] as const) {
  test(`${failure} reply leaves no counter, thread, idempotency or event residue`, async () => {
    const f = fixture();
    const { events } = collect(f);
    try {
      const root = await f.as().sendMessage(f.channelId, {
        client_key: id(120),
        body: "No thread yet",
      });
      const before = f.store.exportSnapshot();
      const eventCount = events.length;
      const input = {
        client_key: id(121),
        body: "Retry me",
        mention_user_ids: [f.peerId],
      };
      const controller = new AbortController();
      if (failure === "fail-next") f.store.failNextCommit();
      const pending = f.as().sendReply(f.channelId, root.message.id, input, {
        signal: controller.signal,
      });
      if (failure === "abort") {
        controller.abort(); // Same-turn cancellation before the serialized commit boundary.
        await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
      } else await httpFailure(pending, 503, "comms_unavailable");
      expect(f.store.exportSnapshot()).toEqual(before);
      expect(events).toHaveLength(eventCount);
      const retry = await f.as().sendReply(f.channelId, root.message.id, input);
      expect(retry).toMatchObject({ status: 201, message: { seq: 2 } });
      expect(
        (await f.as().getThread(f.channelId, root.message.id)).data.reply_count,
      ).toBe(1);
      expect(created(events)).toEqual([1, 2]);
    } finally {
      f.close();
    }
  });
}

test("sparse history uses exclusive cursors and exact sequence includes non-channel replies", async () => {
  const s = setup();
  const root = seedMessage(s, 130, 2);
  seedMessage(s, 131, 5, { parent_id: root.id });
  seedMessage(s, 132, 9, {
    body: "Removed private text",
    deleted_at: "2026-10-19T04:01:00Z",
  });
  seedMessage(s, 133, 14, { parent_id: root.id, also_send_to_channel: true });
  const emptyRoot = seedMessage(s, 134, 20);
  seedMessage(s, 135, 27, { parent_id: root.id });
  seedThread(s, root);
  seedThread(s, emptyRoot, 901); // ID25: existing root with no replies, not a missing thread.
  const f = fixture(s);
  try {
    const latest = await f.as().getHistory(f.channelId, { limit: 2 });
    expect(latest.items.map((m) => m.seq)).toEqual([14, 20]);
    expect(latest.pagination).toEqual({
      limit: 2,
      count: 2,
      first_seq: 14,
      last_seq: 20,
      high_water_seq: 27,
      has_older: true,
      has_newer: false,
    });
    const before = await f
      .as()
      .getHistory(f.channelId, { limit: 2, before_seq: 14 });
    expect(before.items.map((m) => m.seq)).toEqual([2, 9]);
    expect(before.pagination).toMatchObject({
      has_older: false,
      has_newer: true,
      high_water_seq: 27,
    });
    expect(before.items[1]).not.toHaveProperty("body");
    const after = await f
      .as()
      .getHistory(f.channelId, { limit: 2, after_seq: 9 });
    expect(after.items.map((m) => m.seq)).toEqual([14, 20]);
    const around = await f
      .as()
      .getHistory(f.channelId, { limit: 3, around_seq: 9 });
    expect(around.items.map((m) => m.seq)).toContain(9);
    expect(around.items).toHaveLength(3); // Exact left/right balancing is not frozen by S01.
    const replies = await f
      .as()
      .getReplies(f.channelId, root.id, { after_seq: 5 });
    expect(replies.items.map((m) => m.seq)).toEqual([14, 27]);
    expect(
      (await f.as().getMessageBySequence(f.channelId, 5)).data.parent_id,
    ).toBe(root.id);
    const empty = await f.as().getHistory(f.channelId, { after_seq: 27 });
    expect(empty.items).toEqual([]);
    expect(empty.pagination).toMatchObject({
      count: 0,
      first_seq: null,
      last_seq: null,
      high_water_seq: 27,
    });
    // ID25: empty cursor pages retain the direction of existing visible items.
    expect(empty.pagination).toMatchObject({
      has_older: true,
      has_newer: false,
    });
    const emptyBefore = await f.as().getHistory(f.channelId, { before_seq: 2 });
    expect(emptyBefore.items).toEqual([]);
    expect(emptyBefore.pagination).toMatchObject({
      count: 0,
      first_seq: null,
      last_seq: null,
      high_water_seq: 27,
      has_older: false,
      has_newer: true,
    });
    const repliesAfter = await f
      .as()
      .getReplies(f.channelId, root.id, { after_seq: 27 });
    expect(repliesAfter.items).toEqual([]);
    expect(repliesAfter.pagination).toMatchObject({
      count: 0,
      first_seq: null,
      last_seq: null,
      high_water_seq: 27,
      has_older: true,
      has_newer: false,
    });
    const repliesBefore = await f
      .as()
      .getReplies(f.channelId, root.id, { before_seq: 5 });
    expect(repliesBefore.items).toEqual([]);
    expect(repliesBefore.pagination).toMatchObject({
      count: 0,
      first_seq: null,
      last_seq: null,
      high_water_seq: 27,
      has_older: false,
      has_newer: true,
    });
    for (const query of [{}, { around_seq: 1 }]) {
      const emptyTimeline = await f.as().getHistory(f.otherChannelId, query);
      expect(emptyTimeline.items).toEqual([]);
      expect(emptyTimeline.pagination).toMatchObject({
        count: 0,
        first_seq: null,
        last_seq: null,
        high_water_seq: 0,
        has_older: false,
        has_newer: false,
      });
      const emptyThread = await f
        .as()
        .getReplies(f.channelId, emptyRoot.id, query);
      expect(emptyThread.items).toEqual([]);
      expect(emptyThread.pagination).toMatchObject({
        count: 0,
        first_seq: null,
        last_seq: null,
        high_water_seq: 27,
        has_older: false,
        has_newer: false,
      });
    }
  } finally {
    f.close();
  }
});

test("thread creation converges with first reply, GET is read-only, and follow is personal", async () => {
  const f = fixture();
  const { events } = collect(f);
  try {
    const root = await f.as().sendMessage(f.channelId, {
      client_key: id(140),
      body: "Thread starter",
    });
    const before = f.store.exportSnapshot();
    const eventCount = events.length;
    await httpFailure(
      f.as().getThread(f.channelId, root.message.id),
      404,
      "comms_not_found",
    );
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toHaveLength(eventCount);
    const [thread] = await Promise.all([
      f.as().createThread(f.channelId, root.message.id),
      f.as(f.peerId).sendReply(f.channelId, root.message.id, {
        client_key: id(141),
        body: "First reply",
      }),
    ]);
    const current = await f.as().getThread(f.channelId, root.message.id);
    expect(current.data).toMatchObject({
      id: thread.data.id,
      root_message_id: root.message.id,
      reply_count: 1,
    });
    expect((await f.as().listThreads()).items.map((t) => t.id)).toEqual([
      thread.data.id,
    ]);
    expect(
      (
        await f
          .as()
          .followThread(f.channelId, root.message.id, { followed: true })
      ).followed,
    ).toBe(true);
    await f
      .as()
      .followThread(f.channelId, root.message.id, { followed: false });
    expect((await f.as().listThreads({ followed: true })).items).toEqual([]);
    await f
      .as(f.peerId)
      .followThread(f.channelId, root.message.id, { followed: true });
    expect(
      (await f.as(f.peerId).listThreads({ followed: true })).items.map(
        (t) => t.id,
      ),
    ).toEqual([thread.data.id]);
    // Resolve is starter-owned and does not lock; rename/lock remain manager-owned.
    const resolved = await f
      .as()
      .updateThread(
        f.channelId,
        root.message.id,
        { resolved: true },
        { if_match: current.etag },
      );
    await f.as(f.peerId).sendReply(f.channelId, root.message.id, {
      client_key: id(142),
      body: "After resolve",
    });
    const fresh = await f.as().getThread(f.channelId, root.message.id);
    await httpFailure(
      f
        .as()
        .updateThread(
          f.channelId,
          root.message.id,
          { name: "Not a manager" },
          { if_match: fresh.etag },
        ),
      403,
      "comms_capability_denied",
    );
    expect(resolved.data.resolved).toBe(true);
    await f
      .as(f.managerId)
      .updateThread(
        f.channelId,
        root.message.id,
        { locked: true },
        { if_match: fresh.etag },
      );
    await httpFailure(
      f.as(f.peerId).sendReply(f.channelId, root.message.id, {
        client_key: id(143),
        body: "Locked",
      }),
      403,
      "comms_post_denied",
    );
    expect(
      (await f.as().getThread(f.channelId, root.message.id)).data.reply_count,
    ).toBe(2);
  } finally {
    f.close();
  }
});

test("root deletion redacts every read and replay while manager restore preserves identity", async () => {
  const f = fixture();
  try {
    const input = {
      client_key: id(150),
      body: "Private original",
      record_ids: [f.recordId],
    };
    const root = await f.as().sendMessage(f.channelId, input);
    if (root.message.state !== "live")
      throw new Error("New message must be live");
    const recordLinkId = root.message.record_references[0].id;
    await f
      .as()
      .editMessage(f.channelId, root.message.id, edit("Private latest"), {
        if_match: (await f.as().getMessage(f.channelId, root.message.id)).etag,
      });
    const reply = await f.as(f.peerId).sendReply(f.channelId, root.message.id, {
      client_key: id(151),
      body: "Retained reply",
    });
    const quote = await f.as(f.peerId).sendMessage(f.channelId, {
      client_key: id(152),
      body: "Quote pointer only",
      reply_to_id: root.message.id,
    });
    await f
      .as(f.managerId)
      .setPin(f.channelId, root.message.id, { pinned: true });
    const thread = await f.as().getThread(f.channelId, root.message.id);
    const beforeDelete = await f.as().getMessage(f.channelId, root.message.id);
    const deleted = await f.as().deleteMessage(f.channelId, root.message.id, {
      if_match: beforeDelete.etag,
    });
    const replay = await f.as().sendMessage(f.channelId, input);
    expect(replay).toEqual({ status: 200, message: deleted.data });
    expect(deleted.data).toMatchObject({
      state: "deleted",
      id: root.message.id,
      seq: 1,
    });
    for (const field of [
      "body",
      "attachments",
      "record_references",
      "reactions",
      "mention_user_ids",
      "mentions_here",
      "mentions_channel",
      "link_previews",
      "pinned_at",
      "pinned_by",
      "edited_at",
    ])
      expect(deleted.data).not.toHaveProperty(field);
    const publicReads = [
      await f.as().getHistory(f.channelId),
      await f.as().listPins(f.channelId),
      await f.as().search({ q: "Private" }),
      await f.as().listLinkedRecords(),
      await f.as().getMessage(f.channelId, quote.message.id),
      replay,
    ];
    expect(JSON.stringify(publicReads)).not.toContain("Private original");
    expect(JSON.stringify(publicReads)).not.toContain("Private latest");
    expect((await f.as().search({ q: "Private" })).items).toEqual([]);
    expect((await f.as().listLinkedRecords()).items).toEqual([]);
    await httpFailure(
      f.as().getRecordReference(f.channelId, recordLinkId),
      404,
      "comms_not_found",
    );
    expect(
      (await f.as().getReplies(f.channelId, root.message.id)).items.map(
        (m) => m.id,
      ),
    ).toEqual([reply.message.id]);
    expect((await f.as().getThread(f.channelId, root.message.id)).data.id).toBe(
      thread.data.id,
    );
    // Deleted revision content is not a public projection, including for its author.
    const revisions = await Promise.allSettled([
      f.as().listMessageRevisions(f.channelId, root.message.id),
    ]);
    if (revisions[0].status === "fulfilled")
      expect(revisions[0].value.items).toEqual([]);
    else
      expect(revisions[0].reason).toMatchObject({
        kind: "http",
        failure: { status: 404 },
      });
    const removal = (if_match: string) => ({
      conversation_id: f.channelId,
      message_id: root.message.id,
      action: "restore" as const,
      options: { if_match },
    });
    await httpFailure(
      f.handle().command(messageRemovalCommand(removal(deleted.etag))),
      403,
      "comms_capability_denied",
    );
    await httpFailure(
      f
        .handle(f.managerId)
        .command(messageRemovalCommand(removal(beforeDelete.etag))),
      412,
      "comms_precondition_failed",
    );
    const restored = await f
      .handle(f.managerId)
      .command(messageRemovalCommand(removal(deleted.etag)));
    expect(restored.value).toMatchObject({
      state: "live",
      id: root.message.id,
      seq: 1,
      body: "Private latest",
    });
    expect((await f.as().getThread(f.channelId, root.message.id)).data.id).toBe(
      thread.data.id,
    );
    expect(f.summary().high_water_seq).toBe(3);
  } finally {
    f.close();
  }
});

test("edit revisions are immutable and current author/window checks also cover replies", async () => {
  const s = setup();
  s.initial.configuration[`channel:${s.channelId}`] = {
    settings: { edit_window_minutes: 1, delete_window_minutes: 1 },
    capabilities: {
      scope: { kind: "channel", id: s.channelId },
      everyone: {},
      group_grants: [],
    },
  };
  const f = fixture(s);
  const { events } = collect(f);
  try {
    const root = await f
      .as(f.peerId)
      .sendMessage(f.channelId, { client_key: id(160), body: "Parent" });
    const reply = await f.as().sendReply(f.channelId, root.message.id, {
      client_key: id(161),
      body: "Revision zero",
    });
    const first = await f.as().getMessage(f.channelId, reply.message.id);
    f.advance(1_000);
    const changed = await f
      .as()
      .editMessage(f.channelId, reply.message.id, edit("Revision one"), {
        if_match: first.etag,
      });
    expect(changed.data.edited_at).not.toBeNull();
    const history = await f
      .as()
      .listMessageRevisions(f.channelId, reply.message.id);
    expect(history.items.map((r) => r.body)).toEqual(["Revision zero"]);
    await f
      .as()
      .editMessage(f.channelId, reply.message.id, edit("Revision two"), {
        if_match: changed.etag,
      });
    expect(
      (
        await f.as().listMessageRevisions(f.channelId, reply.message.id)
      ).items.map((r) => r.body),
    ).toEqual(["Revision zero", "Revision one"]);
    expect(history.items.map((r) => r.body)).toEqual(["Revision zero"]);
    const fresh = await f.as().getMessage(f.channelId, reply.message.id);
    const before = f.store.exportSnapshot();
    const eventCount = events.length;
    await httpFailure(
      f
        .as(f.managerId)
        .editMessage(
          f.channelId,
          reply.message.id,
          edit("Manager cannot impersonate"),
          { if_match: fresh.etag },
        ),
      403,
      "comms_post_denied",
    );
    await httpFailure(
      f.as(f.peerId).listMessageRevisions(f.channelId, reply.message.id),
      403,
      "comms_capability_denied",
    );
    f.advance(60_001);
    await httpFailure(
      f.as().editMessage(f.channelId, reply.message.id, edit("Too late"), {
        if_match: fresh.etag,
      }),
      403,
      "comms_post_denied",
    );
    await httpFailure(
      f
        .as()
        .deleteMessage(f.channelId, reply.message.id, { if_match: fresh.etag }),
      403,
      "comms_post_denied",
    );
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toHaveLength(eventCount);
    expect(
      (
        await f
          .as(f.managerId)
          .listMessageRevisions(f.channelId, reply.message.id)
      ).items,
    ).toHaveLength(2);
    expect(
      (
        await f.as(f.managerId).deleteMessage(f.channelId, reply.message.id, {
          if_match: fresh.etag,
        })
      ).data.state,
    ).toBe("deleted");
  } finally {
    f.close();
  }
});

test("reply reaction and pin mutations use current capability and actor ownership", async () => {
  const f = fixture();
  try {
    const root = await f
      .as()
      .sendMessage(f.channelId, { client_key: id(170), body: "Root" });
    const reply = await f.as().sendReply(f.channelId, root.message.id, {
      client_key: id(171),
      body: "React here",
    });
    await f.as().addReaction(f.channelId, reply.message.id, { emoji: "👍" });
    await f.as().addReaction(f.channelId, reply.message.id, { emoji: "👍" });
    await f
      .as(f.peerId)
      .addReaction(f.channelId, reply.message.id, { emoji: "👍" });
    const remaining = await f
      .as()
      .removeReaction(f.channelId, reply.message.id, { emoji: "👍" });
    expect(remaining).toMatchObject({
      reactions: [{ emoji: "👍", user_ids: [f.peerId] }],
    });
    expect(
      await f
        .as()
        .removeReaction(f.channelId, reply.message.id, { emoji: "👍" }),
    ).toEqual(remaining);
    const before = f.store.exportSnapshot();
    const { events } = collect(f);
    await httpFailure(
      f.as().setPin(f.channelId, reply.message.id, { pinned: true }),
      403,
      "comms_capability_denied",
    );
    await httpFailure(
      f
        .as(f.guestId)
        .addReaction(f.channelId, reply.message.id, { emoji: "👍" }),
      403,
      "comms_capability_denied",
    );
    await httpFailure(
      f.as(f.guestId).sendReply(f.channelId, root.message.id, {
        client_key: id(172),
        body: "Guest reply",
      }),
      403,
      "comms_post_denied",
    );
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toEqual([]);
    await f
      .as(f.managerId)
      .setPin(f.channelId, reply.message.id, { pinned: true });
    expect((await f.as().listPins(f.channelId)).items.map((m) => m.id)).toEqual(
      [reply.message.id],
    );
    await changeAuthority(f, (draft) => {
      draft.configuration[`channel:${f.channelId}`] = {
        settings: {},
        capabilities: {
          scope: { kind: "channel", id: f.channelId },
          everyone: { react: false },
          group_grants: [],
        },
      };
    });
    await httpFailure(
      f.as(f.peerId).addReaction(f.channelId, root.message.id, { emoji: "👍" }),
      403,
      "comms_capability_denied",
    );
    expect(
      (await f.as().getMessage(f.channelId, reply.message.id)).data,
    ).toMatchObject({ reactions: [{ emoji: "👍", user_ids: [f.peerId] }] });
  } finally {
    f.close();
  }
});

test("search filters before paging, is stable on ties, and drops revoked or deleted content", async () => {
  const s = setup();
  const first = seedMessage(s, 180, 2, {
    body: "needle <b>literal</b>",
    record_links: [{ id: id(20001), record_id: s.recordId }],
    pinned_at: "2026-10-19T04:00:00Z",
    pinned_by: s.managerId,
  });
  const second = seedMessage(s, 181, 7, {
    ...first,
    id: id(181),
    seq: 7,
    client_key: id(10181),
    body: "needle second",
    record_links: [{ id: id(20002), record_id: s.recordId }],
  });
  seedMessage(s, 182, 8, {
    body: "needle wrong author",
    author_id: owner.user_id,
    record_links: [{ id: id(20003), record_id: s.recordId }],
    pinned_at: first.pinned_at,
    pinned_by: s.managerId,
  });
  seedMessage(s, 183, 9, {
    body: "needle private",
    conversation_id: s.hiddenId,
  });
  seedMessage(s, 184, 10, {
    body: "needle deleted",
    deleted_at: "2026-10-19T04:01:00Z",
  });
  seedMessage(s, 185, 11, {
    ...first,
    id: id(185),
    seq: 11,
    client_key: id(10185),
    created_at: "2026-10-17T04:00:00Z",
    record_links: [{ id: id(20004), record_id: s.recordId }],
  });
  seedMessage(s, 186, 12, {
    body: "needle without record",
    pinned_at: first.pinned_at,
    pinned_by: s.managerId,
  });
  seedMessage(s, 187, 13, {
    body: "needle without pin",
    record_links: [{ id: id(20005), record_id: s.recordId }],
  });
  seedMessage(s, 188, 14, {
    body: "Different text",
    record_links: [{ id: id(20006), record_id: s.recordId }],
    pinned_at: first.pinned_at,
    pinned_by: s.managerId,
  });
  const unicode = seedMessage(s, 189, 15, { body: "😀 İ comet" });
  const f = fixture(s);
  try {
    const query = {
      q: "needle",
      from: f.peerId,
      in: f.channelId,
      has: "record" as const,
      is: "pinned" as const,
      after: "2026-10-18",
      before: "2026-10-20",
      sort_by: "created_at" as const,
      sort_order: "asc" as const,
      limit: 1,
    };
    const a = await f.as().search(query);
    const b = await f.as().search({ ...query, offset: 1 });
    expect(
      new Set([...a.items, ...b.items].map((hit) => hit.message_id)),
    ).toEqual(new Set([first.id, second.id]));
    expect(a.pagination).toMatchObject({ total: 2, count: 1, has_more: true });
    expect(b.pagination).toMatchObject({ total: 2, count: 1, has_more: false });
    expect(await f.as().search(query)).toEqual(a);
    const hits = await f.as().search({ q: "needle", on: "2026-10-19" });
    expect(hits.items.map((hit) => hit.message_id).sort()).toEqual([
      id(180),
      id(181),
      id(182),
      id(186),
      id(187),
    ]);
    expect(hits.items.find((hit) => hit.message_id === first.id)?.excerpt).toBe(
      "needle <b>literal</b>",
    ); // Plain text, not generated highlight markup.
    const unicodeHits = await f.as().search({ q: "comet" });
    expect(
      unicodeHits.items.map(({ message_id, excerpt, matches }) => ({
        message_id,
        excerpt,
        matches,
      })),
    ).toEqual([
      {
        message_id: unicode.id,
        excerpt: "😀 İ comet",
        matches: [{ start: 4, end: 9 }],
      },
    ]);
    await changeAuthority(f, (draft) => {
      const channel = draft.conversations[f.channelId];
      if (channel.kind !== "channel")
        throw new Error("Fixture channel required");
      draft.conversations[f.channelId] = {
        ...channel,
        scope: "groups",
        access: [],
      };
    });
    expect((await f.as().search({ q: "needle" })).items).toEqual([]);
    await httpFailure(
      f.as().getMessage(f.channelId, first.id),
      404,
      "comms_not_found",
    );
    await httpFailure(f.as().listPins(f.channelId), 404, "comms_not_found");
  } finally {
    f.close();
  }
});
