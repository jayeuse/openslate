/** PROMOTED / UNRUN. Real store + real family factories only. */
import {
  expect,
  id,
  iso,
  now,
  refuses,
  settings,
  test,
} from "./memory-operational-fixture";

test("report submission reaches only moderators; resolve/remove/restore use the shared transition", async ({
  make,
}) => {
  const f = make(),
    reporter = f.as(),
    moderator = f.as(f.managerId);
  f.store.failNextCommit();
  await refuses(
    f,
    () =>
      reporter.reportMessage(f.channelId, f.rootId, {
        reason: "Check dispatch details",
      }),
    503,
    "comms_unavailable",
  );
  expect(
    await reporter.reportMessage(f.channelId, f.rootId, {
      reason: "Check dispatch details",
    }),
  ).toBeUndefined();
  const queue = await moderator.listReports();
  expect(queue.items).toHaveLength(1);
  const report = queue.items[0];
  expect(report).toMatchObject({
    conversation_id: f.channelId,
    message_id: f.rootId,
    reporter_id: f.context.user_id,
    reason: "Check dispatch details",
    status: "open",
  });
  await refuses(
    f,
    () => reporter.listReports(),
    403,
    "comms_capability_denied",
  );
  await refuses(
    f,
    () => reporter.getReport(report.id),
    403,
    "comms_capability_denied",
  );
  const pending = await moderator.getReport(report.id);
  expect(
    await moderator.resolveReport(report.id, { if_match: pending.etag }),
  ).toMatchObject({ id: report.id, status: "resolved" });
  expect((await reporter.getMessage(f.channelId, f.rootId)).data.state).toBe(
    "live",
  );

  const message = await moderator.getMessage(f.channelId, f.rootId);
  await refuses(
    f,
    () =>
      reporter.removeMessage(f.channelId, f.rootId, { if_match: message.etag }),
    403,
    "comms_capability_denied",
  );
  const removed = await moderator.removeMessage(f.channelId, f.rootId, {
    if_match: message.etag,
  });
  expect(removed.data).toMatchObject({
    id: f.rootId,
    state: "deleted",
    seq: 1,
  });
  expect(removed.data).not.toHaveProperty("body");
  expect(
    (await moderator.listRemovedMessages(f.channelId)).items.map((m) => m.id),
  ).toEqual([f.rootId]);
  await refuses(
    f,
    () => reporter.listRemovedMessages(f.channelId),
    403,
    "comms_capability_denied",
  );
  await refuses(
    f,
    () =>
      reporter.restoreMessage(f.channelId, f.rootId, {
        if_match: removed.etag,
      }),
    403,
    "comms_capability_denied",
  );
  const restored = await moderator.restoreMessage(f.channelId, f.rootId, {
    if_match: removed.etag,
  });
  expect(restored.data).toMatchObject({
    id: f.rootId,
    state: "live",
    seq: 1,
    body: "Review this dispatch",
  });
  expect((await reporter.getThread(f.channelId, f.rootId)).data).toMatchObject({
    id: f.threadId,
    reply_count: 1,
  });
  expect(
    (await reporter.getReplies(f.channelId, f.rootId)).items.map((m) => m.id),
  ).toEqual([f.replyId]);
  expect((await moderator.listRemovedMessages(f.channelId)).items).toEqual([]);

  // An author may delete their own message, but the moderator wrapper must not
  // accidentally turn that separate entitlement into an own-restore entitlement.
  const own = await reporter.sendMessage(f.channelId, {
    client_key: id(101),
    body: "Own dispatch",
  });
  const ownDeleted = await reporter.deleteMessage(f.channelId, own.message.id);
  await refuses(
    f,
    () =>
      reporter.restoreMessage(f.channelId, own.message.id, {
        if_match: ownDeleted.etag,
      }),
    403,
    "comms_capability_denied",
  );
});

test("report and moderation calls refuse hidden and foreign resources without a success-shaped queue", async ({
  make,
}) => {
  const f = make(),
    foreign = make({ offset: 1000 });
  await foreign.as().reportMessage(foreign.channelId, foreign.rootId, {
    reason: "Foreign report",
  });
  const foreignReport = (await foreign.as(foreign.managerId).listReports())
    .items[0];
  const foreignState = structuredClone(foreign.store.exportSnapshot());
  const foreignEvents = structuredClone(foreign.deliveries);
  const foreignMessage = await foreign
    .as(foreign.managerId)
    .getMessage(foreign.channelId, foreign.rootId);
  await refuses(
    f,
    () =>
      f.as().reportMessage(foreign.channelId, foreign.rootId, {
        reason: "Wrong org",
      }),
    404,
    "comms_not_found",
  );
  await refuses(
    f,
    () => f.as(f.managerId).getReport(foreignReport.id),
    404,
    "comms_not_found",
  );
  await refuses(
    f,
    () =>
      f.as(f.managerId).removeMessage(foreign.channelId, foreign.rootId, {
        if_match: foreignMessage.etag,
      }),
    404,
    "comms_not_found",
  );
  await refuses(
    f,
    () =>
      f
        .as(f.outsiderId)
        .reportMessage(f.channelId, f.rootId, { reason: "Hidden source" }),
    404,
    "comms_not_found",
  );
  expect((await f.as(f.managerId).listReports()).items).toEqual([]);
  expect(foreign.store.exportSnapshot()).toEqual(foreignState);
  expect(foreign.deliveries).toEqual(foreignEvents);
});

test("restrictions, lock and slow mode affect real send commands rather than a second tools state", async ({
  make,
}) => {
  const f = make(),
    actor = f.as(),
    moderator = f.as(f.managerId);
  const scope = { kind: "channel", id: f.channelId } as const;
  const original = await moderator.getSettings(scope);
  await refuses(
    f,
    () =>
      actor.setPostingRestrictions(
        f.channelId,
        { user_ids: [f.peerId], until: null },
        { if_match: original.etag },
      ),
    403,
    "comms_capability_denied",
  );
  const restricted = await moderator.setPostingRestrictions(
    f.channelId,
    {
      user_ids: [f.context.user_id],
      until: iso(now + 60_000),
    },
    { if_match: original.etag },
  );
  expect(restricted.data.effective.restricted_person_ids).toEqual([
    f.context.user_id,
  ]);
  expect((await actor.getSettings(scope)).etag).toBe(restricted.etag);
  const changes = Object.values(f.store.exportSnapshot().state.history);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    scope,
    after: {
      settings: {
        restricted_person_ids: [f.context.user_id],
        restriction_until: iso(now + 60_000),
      },
    },
  });
  await refuses(
    f,
    () =>
      actor.sendMessage(f.channelId, {
        client_key: id(102),
        body: "Restricted",
      }),
    403,
    "comms_post_denied",
  );
  f.advance(60_000);
  expect(
    (
      await actor.sendMessage(f.channelId, {
        client_key: id(103),
        body: "Restriction expired",
      })
    ).message.seq,
  ).toBe(3);
  await settings(f, { locked: true });
  await refuses(
    f,
    () =>
      actor.sendMessage(f.channelId, { client_key: id(104), body: "Locked" }),
    403,
    "comms_post_denied",
  );
  await settings(f, { locked: false, slow_mode_seconds: 30 });
  await refuses(
    f,
    () =>
      actor.sendReply(f.channelId, f.rootId, {
        client_key: id(105),
        body: "Too soon",
      }),
    429,
    "comms_slow_mode",
  );
  f.advance(30_000);
  expect(
    (
      await actor.sendReply(f.channelId, f.rootId, {
        client_key: id(106),
        body: "After slow mode",
      })
    ).message.seq,
  ).toBe(4);
});
