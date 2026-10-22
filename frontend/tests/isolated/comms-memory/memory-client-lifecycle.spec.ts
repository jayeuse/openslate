/** PROMOTED / UNRUN — real protected preparation, shared send recipe and owner lifetime. */
import type * as C from "@/components/systems/comms/contract/types";
import type { MemorySnapshot } from "../../support/comms-memory/memory/store-types";
import {
  test,
  expect,
  barrier,
  marker,
  workspace,
  send,
  schedule,
  upload,
  refuses,
  result,
  afterRelease,
  createdSequences,
  observe,
  now,
  foreignOrg,
  png,
  scheduleCompletion,
} from "./memory-client-fixture";

test("J3 expiry interrupts a real protected preview as 401 and restoration cannot revive it or caller cancellation", async ({
  make,
}) => {
  const expiryGate = barrier(),
    abortGate = barrier();
  let nextGate: ReturnType<typeof barrier> | undefined = expiryGate;
  const f = make({
    verifyConfirmation: async (value) => {
      const gate = nextGate;
      nextGate = undefined;
      if (gate) await gate.hold(); // Deliberately ignores abort while held.
      return value === marker; // Exact nonsecret ID19 seam, not a client/family stub.
    },
  });
  const policy = { scope: workspace, message_days: 30, file_days: 0 };
  const current = await f.client.getRetention(workspace);
  const options = { if_match: current.etag, password: marker };
  const before = f.runtime.exportSnapshot(),
    events = structuredClone(f.events);
  const expired = result(f.client.previewRetention(policy, options));
  try {
    await expiryGate.reached;
    f.runtime.controls.setTokenExpired(true);
    expect(f.connections.at(-1)).toEqual({
      state: "paused",
      reason: "authentication",
    });
    expect(f.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "http",
          failure: expect.objectContaining({ status: 401 }),
        }),
      ]),
    );
    const joinedExpired = observe(f.client);
    try {
      expect(joinedExpired.connections).toEqual([
        { state: "paused", reason: "authentication" },
      ]);
    } finally {
      joinedExpired.stop();
    }
    await refuses(f, () => f.client.getConversation(f.channelId), 401);
    await refuses(
      f,
      () => f.client.sendMessage(f.channelId, send("Expired request", 6)),
      401,
    );
    f.runtime.controls.setTokenExpired(false); // Restore BEFORE the verifier resolves.
    expect(await expired).toMatchObject({
      kind: "http",
      failure: { status: 401 },
    });
    expect(f.connections.at(-1)).toEqual({ state: "live" });
    expect(await f.client.getRetention(workspace)).toEqual(current);

    nextGate = abortGate;
    const abort = new AbortController();
    const cancelled = result(
      f.client.previewRetention(policy, { ...options, signal: abort.signal }),
    );
    await abortGate.reached;
    abort.abort(); // Caller cancellation wins BEFORE a later expiry transition.
    f.runtime.controls.setTokenExpired(true);
    f.runtime.controls.setTokenExpired(false);
    expect(await cancelled).toMatchObject({ kind: "cancelled" });

    // One observable late-install witness, reusing ID19's accepted 32-entry bound.
    // No registry introspection or second expiry/eviction matrix.
    const live: C.RetentionPreview[] = [];
    for (let i = 0; i < 32; i += 1)
      live.push(await f.client.previewRetention(policy, options));
    expiryGate.release();
    abortGate.release();
    await afterRelease();
    expect(await expired).toMatchObject({
      kind: "http",
      failure: { status: 401 },
    });
    expect(await cancelled).toMatchObject({ kind: "cancelled" });
    expect(f.runtime.exportSnapshot()).toEqual(before);
    expect(f.events).toEqual(events);
    // A late 33rd installation would evict this still-live oldest preview.
    expect(
      (
        await f.client.updateRetention(
          { ...policy, preview_digest: live[0].preview_digest },
          options,
        )
      ).data.effective,
    ).toEqual({ message_days: 30, file_days: 0 });
  } finally {
    expiryGate.release();
    abortGate.release();
  }
});

test("J5 fail-next-send survives other commits invalid input cancellation and replay across the shared recipe", async ({
  make,
}) => {
  const gate = barrier(),
    f = make({ beforeScheduleSend: gate.hold });
  const originalRequest = send("Original accepted root", 10);
  const sending = f.client.sendMessage(f.channelId, originalRequest);
  f.runtime.refreshOwnerDisplayName(f.context, "Alex Refreshed");
  const original = await sending;
  expect(original).toMatchObject({ status: 201, message: { seq: 3 } });
  expect(f.runtime.client).toBe(f.client);
  expect(original.message.author_id).toBe(f.context.user_id);
  expect(
    f.runtime.exportSnapshot().state.people[f.context.user_id],
  ).toMatchObject({
    user_id: f.context.user_id,
    role: "admin",
    display_name: "Alex Refreshed",
  });
  const displayedMembers = (await f.client.listMembers(f.channelId)).items;
  expect(displayedMembers).toContainEqual(
    expect.objectContaining({
      user_id: f.context.user_id,
      display_name: "Alex Refreshed",
    }),
  );
  expect(displayedMembers).toContainEqual(
    expect.objectContaining({ user_id: f.peerId, display_name: "Alex" }),
  );
  f.runtime.controls.failNextSend();
  const prefs = await f.client.getMemberPreferences(f.channelId);
  await f.client.updateMemberPreferences(
    f.channelId,
    { starred: true },
    { if_match: prefs.etag },
  );
  await refuses(
    f,
    () => f.client.sendMessage(f.channelId, send("", 11)),
    422,
    "comms_message_empty",
  );
  const beforeReplay = f.runtime.exportSnapshot(),
    replayEvents = structuredClone(f.events);
  expect(await f.client.sendMessage(f.channelId, originalRequest)).toEqual({
    status: 200,
    message: original.message,
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.client.sendMessage(f.channelId, send("Cancelled new send", 12), {
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ kind: "cancelled" });
  expect(f.runtime.exportSnapshot()).toEqual(beforeReplay);
  expect(f.events).toEqual(replayEvents);
  const retryRequest = send("Retry the same valid key", 13);
  const version = await f.client.getConversation(f.channelId);
  await refuses(
    f,
    () => f.client.sendMessage(f.channelId, retryRequest),
    503,
    "comms_unavailable",
  );
  expect(await f.client.getConversation(f.channelId)).toEqual(version);
  const retried = await f.client.sendMessage(f.channelId, retryRequest);
  expect(retried).toMatchObject({ status: 201, message: { seq: 4 } });
  expect(await f.client.sendMessage(f.channelId, retryRequest)).toEqual({
    status: 200,
    message: retried.message,
  });
  expect(
    Object.values(f.runtime.exportSnapshot().state.messages).filter(
      (m) => m.client_key === retryRequest.client_key,
    ),
  ).toHaveLength(1);
  expect(createdSequences(f.events)).toEqual([3, 4]);

  f.runtime.controls.failNextSend();
  const reply = {
    ...send("Shared recipe reply", 14),
    also_send_to_channel: false,
  };
  await refuses(
    f,
    () => f.client.sendReply(f.channelId, f.rootId, reply),
    503,
    "comms_unavailable",
  );
  expect(await f.client.sendReply(f.channelId, f.rootId, reply)).toMatchObject({
    status: 201,
    message: { seq: 5, parent_id: f.rootId },
  });
  expect(createdSequences(f.events)).toEqual([3, 4, 5]);

  f.runtime.controls.failNextSend();
  const scheduled = await f.client.createSchedule(schedule(f, 15));
  f.advance(60_000);
  const pumping = f.runtime.controls.pumpDue();
  try {
    await gate.reached;
    expect((await f.client.getSchedule(scheduled.data.id)).data.status).toBe(
      "running",
    );
    f.runtime.controls.setTokenExpired(true); // Autonomous stored-author work is independent.
  } finally {
    gate.release();
    await pumping;
  }
  f.runtime.controls.setTokenExpired(false);
  expect((await f.client.getSchedule(scheduled.data.id)).data).toMatchObject({
    status: "failed",
    failure_code: "unavailable",
    message_id: null,
  });
  expect(
    (await f.client.getHistory(f.channelId)).pagination.high_water_seq,
  ).toBe(5);
  expect(createdSequences(f.events)).toEqual([3, 4, 5]);
  // Creation/claim did not consume the fault; the actual send did, exactly once.
  const next = await f.client.createSchedule({
    ...schedule(f, 16),
    send_at: new Date(now + 120_000).toISOString(),
  });
  f.advance(60_000);
  f.runtime.controls.setTokenExpired(true);
  await f.runtime.controls.pumpDue(); // Released barrier remains open, no clock sleep.
  f.runtime.controls.setTokenExpired(false);
  const done = (await f.client.getSchedule(next.data.id)).data;
  expect(done).toMatchObject({ status: "succeeded", failure_code: null });
  expect(
    (await f.client.getMessage(f.channelId, done.message_id!)).data,
  ).toMatchObject({ seq: 6, author_id: f.context.user_id });
  // Paused event transport does not replay the successful scheduled message.
  expect(createdSequences(f.events)).toEqual([3, 4, 5]);
});

test("J6 disposing the owner cancels pending work and a restored owner has no faults activity proofs or bytes", async ({
  make,
}) => {
  const gate = barrier(),
    old = make({ beforeScheduleSend: gate.hold });
  const file = await upload(old);
  const retention = await old.client.getRetention(workspace);
  const policy = { scope: workspace, message_days: 30, file_days: 0 };
  const preview = await old.client.previewRetention(policy, {
    if_match: retention.etag,
    password: marker,
  });
  await old.client.heartbeatPresence({ state: "online" });
  await old.client.sendTyping(old.channelId);
  const canonical = old.runtime.exportSnapshot();
  old.runtime.controls.failNextSend();
  old.runtime.controls.denyCapability({
    scope: old.channelScope,
    capability: "react",
  });
  old.runtime.controls.setConnectionDropped(true);
  old.runtime.controls.setTokenExpired(true);
  const snapshot = old.runtime.exportSnapshot(); // Owner API, not an expired client read.
  expect(snapshot).toEqual(canonical);
  old.runtime.controls.setTokenExpired(false);
  const oldRequest = send("Old continuation must never install", 20);
  const oldWrite = () => old.client.sendMessage(old.channelId, oldRequest);
  await old.client.createSchedule({ ...schedule(old, 20), ...oldRequest });
  old.advance(60_000);
  const pending = result(old.runtime.controls.pumpDue());
  try {
    await gate.reached;
    old.runtime.controls.setTokenExpired(true);
    old.runtime.dispose(); // Actual owner lifetime, not just a fixture unsubscribe.
    expect(await pending).toMatchObject({ kind: "cancelled" });
    const oldEvents = structuredClone(old.events),
      oldChanges = old.changes();
    const fresh = make({ snapshot });
    expect(fresh.runtime.restoration).toBe("restored");
    expect(fresh.connections).toEqual([{ state: "live" }]);
    expect(fresh.errors).toEqual([]);
    expect((await fresh.client.bootstrap()).org_id).toBe(old.context.org_id);
    expect(
      (await fresh.client.getCapabilities(fresh.channelId)).capabilities.react,
    ).toEqual({ allowed: true, source: { kind: "admin" } });
    expect(
      await fresh.client.getPresence({ user_ids: [fresh.context.user_id] }),
    ).toEqual({
      org_id: fresh.context.org_id,
      items: [{ user_id: fresh.context.user_id, state: "offline" }],
    });
    await refuses(
      fresh,
      () => fresh.client.downloadAttachment(fresh.channelId, file.id),
      404,
      "file_not_found",
    );
    const freshTag = (await fresh.client.getRetention(workspace)).etag;
    await refuses(
      fresh,
      () =>
        fresh.client.updateRetention(
          { ...policy, preview_digest: preview.preview_digest },
          { if_match: freshTag, password: marker },
        ),
      409,
      "comms_conflict",
    );
    const beforeLate = fresh.runtime.exportSnapshot(),
      freshChanges = fresh.changes();
    gate.release();
    await afterRelease();
    await expect(oldWrite()).rejects.toMatchObject({ kind: "cancelled" });
    expect(fresh.runtime.exportSnapshot()).toEqual(beforeLate);
    expect(fresh.events).toEqual([]);
    expect(fresh.changes()).toBe(freshChanges);
    expect(old.events).toEqual(oldEvents);
    expect(old.changes()).toBe(oldChanges);
    expect((await fresh.client.listSchedules()).items).toEqual([]); // Allowed snapshot predates old claim.
    expect(
      await fresh.client.sendMessage(fresh.channelId, oldRequest),
    ).toMatchObject({ status: 201, message: { seq: 3 } });
    await fresh.client.addReaction(fresh.channelId, fresh.rootId, {
      emoji: "👍",
    });
    expect(createdSequences(fresh.events)).toEqual([3]);
  } finally {
    gate.release();
  }
});

test("J7 ID31 admission preserves claimed jobs and bytes while fresh role installation orders completion", async ({
  make,
}) => {
  const firstJobGate = barrier(),
    secondJobGate = barrier(),
    previewGate = barrier();
  let nextJobGate = firstJobGate;
  let onPreviewAbort = () => {};
  const f = make({
    beforeScheduleSend: async () => {
      await nextJobGate.hold();
    },
    verifyConfirmation: async (value, signal) => {
      signal.addEventListener("abort", () => onPreviewAbort(), { once: true });
      await previewGate.hold(); // Real protected preparation deliberately ignores abort.
      return value === marker;
    },
  });
  const captured = f.client;
  const file = await upload(f),
    bytes = await png().arrayBuffer();
  const sent = await captured.sendMessage(f.channelId, {
    ...send("Content and bytes survive admission", 30),
    attachment_ids: [file.id],
  });
  expect(sent).toMatchObject({
    status: 201,
    message: { seq: 3, author_id: f.context.user_id },
  });
  const retainedMessage = await captured.getMessage(
    f.channelId,
    sent.message.id,
  );
  const first = await captured.createSchedule({
    ...schedule(f, 31),
    body: "Completed while browser admission is closed",
  });
  const firstCompletion = scheduleCompletion(f, first.data.id);
  let secondCompletion: ReturnType<typeof scheduleCompletion> | undefined;
  let replacementEvents: ReturnType<typeof observe> | undefined;
  let guestEvents: ReturnType<typeof observe> | undefined;
  let stopAdmissionNotices: (() => void) | undefined;
  try {
    f.advance(60_000);
    const firstWait = result(
      captured.sendScheduleNow(first.data.id, { if_match: first.etag }),
    );
    await firstJobGate.reached;
    const claimed = f.runtime.exportSnapshot(),
      claimedChanges = f.changes();
    expect(claimed.state.schedules[first.data.id].status).toBe("running");
    const oldEvents = structuredClone(f.events);
    const firstTicket = f.runtime.suspendAdmission();
    expect(await firstWait).toMatchObject({ kind: "cancelled" });
    await expect(captured.getConversation(f.channelId)).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(f.runtime.exportSnapshot()).toEqual(claimed);
    expect(f.changes()).toBe(claimedChanges);

    // Order 1: accepted job completes before any fresh identity is installed.
    firstJobGate.release();
    const completed = await firstCompletion.completed;
    expect(completed).toMatchObject({
      id: first.data.id,
      status: "succeeded",
      failure_code: null,
    });
    expect(completed.message_id).not.toBeNull();
    const closed = f.runtime.exportSnapshot();
    expect(closed.state.messages[completed.message_id!]).toMatchObject({
      seq: 4,
      author_id: f.context.user_id,
      body: "Completed while browser admission is closed",
    });
    expect(closed.state.high_water_seq[f.channelId]).toBe(4);
    expect(
      Object.values(closed.state.messages).filter(
        (m) => m.client_key === first.data.request.client_key,
      ),
    ).toHaveLength(1);
    expect(f.changes()).toBe(claimedChanges + 1);
    expect(f.events).toEqual(oldEvents);
    await expect(
      Promise.resolve().then(() =>
        f.runtime.client.getConversation(f.channelId),
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });

    const invalidAdmissions: unknown[] = [
      {
        context: { ...f.context, org_id: foreignOrg },
        role: "admin",
        display_name: "Wrong organization",
      },
      {
        context: { ...f.context, user_id: f.peerId },
        role: "admin",
        display_name: "Wrong owner",
      },
      null,
      {
        context: f.context,
        role: "admin",
        display_name: "Inactive admission",
        active: false,
      },
    ];
    const closedChanges = f.changes();
    for (const input of invalidAdmissions) {
      const invalidTicket = f.runtime.suspendAdmission(); // Each refusal exercises a current, unconsumed cycle.
      expect(f.runtime.acceptAdmission(invalidTicket, input)).toBe(false);
      expect(f.runtime.exportSnapshot()).toEqual(closed);
      expect(f.changes()).toBe(closedChanges);
      await expect(
        Promise.resolve().then(() =>
          f.runtime.client.getConversation(f.channelId),
        ),
      ).rejects.toMatchObject({ kind: "cancelled" });
    }
    f.runtime.refreshOwnerDisplayName(f.context, "Closed display refresh");
    expect(
      f.runtime.exportSnapshot().state.people[f.context.user_id],
    ).toMatchObject({
      user_id: f.context.user_id,
      org_id: f.context.org_id,
      role: "admin",
      active: true,
    });
    await expect(
      Promise.resolve().then(() =>
        f.runtime.client.getConversation(f.channelId),
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });

    const replacementTicket = f.runtime.suspendAdmission();
    expect(replacementTicket).not.toBe(firstTicket);
    const beforeAccept = f.runtime.exportSnapshot(),
      beforeAcceptChanges = f.changes();
    const admitted = {
      context: f.context,
      role: "admin" as const,
      display_name: "Alex Readmitted",
    };
    expect(f.runtime.acceptAdmission(firstTicket, admitted)).toBe(false); // Superseded, never consumed.
    expect(f.runtime.exportSnapshot()).toEqual(beforeAccept);
    expect(f.changes()).toBe(beforeAcceptChanges);
    expect(f.runtime.acceptAdmission(replacementTicket, admitted)).toBe(true);
    const replacement = f.runtime.client;
    expect(replacement).not.toBe(captured);
    expect(replacement.context).toEqual(f.context);
    // Authority version bookkeeping is not prescribed; every other canonical field is retained.
    expect(f.runtime.exportSnapshot()).toEqual({
      ...beforeAccept,
      state: {
        ...beforeAccept.state,
        resource_versions: expect.any(Object),
        people: {
          ...beforeAccept.state.people,
          [f.context.user_id]: {
            ...beforeAccept.state.people[f.context.user_id],
            role: "admin",
            display_name: "Alex Readmitted",
          },
        },
      },
    });
    expect(f.changes()).toBe(beforeAcceptChanges + 1);
    expect(await replacement.getMessage(f.channelId, sent.message.id)).toEqual(
      retainedMessage,
    ); // Same ID and ETag/incarnation.
    expect(
      await (
        await replacement.downloadAttachment(f.channelId, file.id)
      ).bytes.arrayBuffer(),
    ).toEqual(bytes);
    replacementEvents = observe(replacement);
    expect(replacementEvents.events).toEqual([]); // No replay from the closed interval.

    nextJobGate = secondJobGate;
    const second = await replacement.createSchedule({
      ...schedule(f, 32),
      send_at: new Date(now + 120_000).toISOString(),
    });
    secondCompletion = scheduleCompletion(f, second.data.id);
    f.advance(60_000);
    const secondWait = result(
      replacement.sendScheduleNow(second.data.id, { if_match: second.etag }),
    );
    await secondJobGate.reached;
    const retention = await replacement.getRetention(workspace);
    const policy = { scope: workspace, message_days: 30, file_days: 0 };
    let reentrantRead: Promise<unknown> | undefined;
    onPreviewAbort = () => {
      // The real read projects synchronously: later command cancellation cannot hide early exposure.
      reentrantRead = result(replacement.getConversation(f.channelId));
    };
    const preview = result(
      replacement.previewRetention(policy, {
        if_match: retention.etag,
        password: marker,
      }),
    );
    await previewGate.reached;
    const beforeGuest = f.runtime.exportSnapshot(),
      beforeGuestChanges = f.changes();
    const retiredEvents = structuredClone(replacementEvents.events);
    expect(beforeGuest.state.schedules[second.data.id].status).toBe("running");
    const guestTicket = f.runtime.suspendAdmission();
    // All browser work settles before either held dependency is released.
    expect(await preview).toMatchObject({ kind: "cancelled" });
    expect(await secondWait).toMatchObject({ kind: "cancelled" });
    expect(await reentrantRead).toMatchObject({ kind: "cancelled" });
    expect(f.runtime.exportSnapshot()).toEqual(beforeGuest);
    expect(f.changes()).toBe(beforeGuestChanges);

    // Order 2: the fresh guest role linearizes before the accepted job completes.
    const admissionNotices: MemorySnapshot[] = [];
    stopAdmissionNotices = f.runtime.subscribe(() => {
      admissionNotices.push(f.runtime.exportSnapshot());
    });
    expect(
      f.runtime.acceptAdmission(guestTicket, {
        context: f.context,
        role: "guest",
        display_name: "Alex Guest",
      }),
    ).toBe(true);
    const guest = f.runtime.client;
    expect(guest).not.toBe(replacement);
    expect(guest.context).toEqual(f.context);
    const installedGuest = f.runtime.exportSnapshot();
    expect(installedGuest).toEqual({
      ...beforeGuest,
      state: {
        ...beforeGuest.state,
        resource_versions: expect.any(Object),
        people: {
          ...beforeGuest.state.people,
          [f.context.user_id]: {
            ...beforeGuest.state.people[f.context.user_id],
            role: "guest",
            display_name: "Alex Guest",
          },
        },
      },
    });
    expect(f.changes()).toBe(beforeGuestChanges + 1);
    expect(admissionNotices).toEqual([installedGuest]);
    stopAdmissionNotices();
    expect(await guest.getMessage(f.channelId, sent.message.id)).toEqual(
      retainedMessage,
    );
    expect(
      await (
        await guest.downloadAttachment(f.channelId, file.id)
      ).bytes.arrayBuffer(),
    ).toEqual(bytes);
    guestEvents = observe(guest);
    expect(await guest.getCapabilities(f.channelId)).toMatchObject({
      user_id: f.context.user_id,
      membership_role: "guest",
      conversation_level: "read",
      capabilities: {
        react: { allowed: false, source: { kind: "guest_cap" } },
      },
    });
    await refuses(
      f,
      () => guest.addReaction(f.channelId, f.rootId, { emoji: "👍" }),
      403,
      "comms_capability_denied",
    );
    expect(f.runtime.acceptAdmission(replacementTicket, admitted)).toBe(false); // Old admin cycle.
    expect(f.runtime.acceptAdmission(guestTicket, admitted)).toBe(false); // Consumed current ticket cannot upgrade.
    expect(f.runtime.exportSnapshot()).toEqual(installedGuest);
    expect(f.changes()).toBe(beforeGuestChanges + 1);

    secondJobGate.release();
    expect(await secondCompletion.completed).toMatchObject({
      id: second.data.id,
      status: "failed",
      failure_code: "post_denied",
      message_id: null,
    });
    const failed = f.runtime.exportSnapshot();
    expect(failed.state.messages).toEqual(installedGuest.state.messages);
    expect(failed.state.high_water_seq[f.channelId]).toBe(4);
    expect(
      Object.values(failed.state.messages).filter(
        (m) => m.client_key === second.data.request.client_key,
      ),
    ).toEqual([]);
    expect(createdSequences(guestEvents.events)).toEqual([]);
    expect(f.changes()).toBe(beforeGuestChanges + 2); // One identity install, one terminal job failure.

    const afterFailureChanges = f.changes(),
      afterFailureEvents = structuredClone(guestEvents.events);
    previewGate.release();
    await afterRelease();
    expect(await preview).toMatchObject({ kind: "cancelled" });
    expect(f.runtime.exportSnapshot()).toEqual(failed);
    expect(f.changes()).toBe(afterFailureChanges);
    expect(guestEvents.events).toEqual(afterFailureEvents);
    expect(replacementEvents.events).toEqual(retiredEvents);
    expect(f.events).toEqual(oldEvents);
    await expect(captured.getConversation(f.channelId)).rejects.toMatchObject({
      kind: "cancelled",
    });
    await expect(
      replacement.getConversation(f.channelId),
    ).rejects.toMatchObject({ kind: "cancelled" });
    await refuses(
      f,
      () =>
        guest.previewRetention(policy, {
          if_match: retention.etag,
          password: marker,
        }),
      403,
      "comms_admin_required",
    );
  } finally {
    firstJobGate.release();
    secondJobGate.release();
    previewGate.release();
    firstCompletion.stop();
    secondCompletion?.stop();
    replacementEvents?.stop();
    guestEvents?.stop();
    stopAdmissionNotices?.();
  }
});
