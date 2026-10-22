/** PROMOTED / UNRUN. Includes the accepted ID21 operational integration additions. */
import { createMessageFamily } from "../../support/comms-memory/memory/messages";
import { createOperationalFamily } from "../../support/comms-memory/memory/operations";
import { createOperationalResources } from "../../support/comms-memory/memory/operational-resources";
import { caught, deferred } from "./memory-store-fixture";
import {
  barrier,
  created,
  expect,
  id,
  iso,
  now,
  refuses,
  schedule,
  settings,
  test,
  upload,
} from "./memory-operational-fixture";

test("schedule edit/send-now/cancel preserve author and files and commit message plus success together", async ({
  make,
}) => {
  const f = make(),
    author = f.as();
  const file = await upload(f);
  const request = schedule(f, 201, {
    body: "Before edit",
    attachment_ids: [file.id],
  });
  const job = await author.createSchedule(request);
  expect(job.data).toMatchObject({
    author_id: f.context.user_id,
    status: "pending",
    message_id: null,
    failure_code: null,
  });
  const changed = {
    ...request,
    body: "Edited dispatch",
    send_at: iso(now + 120_000),
  };
  const updated = await author.updateSchedule(job.data.id, changed, {
    if_match: job.etag,
  });
  await refuses(
    f,
    () => author.updateSchedule(job.data.id, request, { if_match: job.etag }),
    412,
    "comms_precondition_failed",
  );
  await refuses(
    f,
    () => f.as(f.peerId).getSchedule(job.data.id),
    404,
    "comms_not_found",
  );
  const observations: {
    status: string;
    message_id: string | null;
    seq: number;
  }[] = [];
  const stop = f.store.subscribe(() => {
    const state = f.store.exportSnapshot().state;
    const sent = Object.values(state.messages).find(
      (m) => m.client_key === id(201),
    );
    if (sent)
      observations.push({
        status: state.schedules[job.data.id].status,
        message_id: state.schedules[job.data.id].message_id,
        seq: sent.seq,
      });
  });
  const sent = await author.sendScheduleNow(job.data.id, {
    if_match: updated.etag,
  });
  stop();
  expect(sent).toMatchObject({ status: "succeeded", failure_code: null });
  expect(sent.message_id).not.toBeNull();
  expect(observations).toEqual([
    { status: "succeeded", message_id: sent.message_id, seq: 3 },
  ]);
  const message = (await author.getMessage(f.channelId, sent.message_id!)).data;
  expect(message).toMatchObject({
    author_id: f.context.user_id,
    client_key: id(201),
    body: "Edited dispatch",
    seq: 3,
    attachments: [{ id: file.id }],
  });
  expect((await author.getSchedule(job.data.id)).data).toEqual(sent);

  const cancelled = await author.createSchedule(
    schedule(f, 202, { body: "Never dispatch" }),
  );
  expect(
    await author.cancelSchedule(cancelled.data.id, {
      if_match: cancelled.etag,
    }),
  ).toMatchObject({ status: "cancelled", message_id: null });
  f.advance(240_000);
  await f.controls.pumpDue();
  expect(created(f)).toHaveLength(1);
  expect(
    (await author.getHistory(f.channelId)).items.map((m) => m.seq),
  ).toEqual([1, 3]);
  expect(
    (await author.listSchedules()).items.map((s) => s.status).sort(),
  ).toEqual(["cancelled", "succeeded"]);
});

test("due claim wins once against another pump/send-now and preserves thread context", async ({
  make,
}) => {
  const gate = barrier(),
    f = make({ beforeScheduleSend: gate.hold }),
    author = f.as();
  const job = await author.createSchedule(
    schedule(f, 203, {
      parent_id: f.rootId,
      reply_to_id: f.rootId,
      also_send_to_channel: true,
      body: "Scheduled reply",
    }),
  );
  f.advance(60_000);
  const first = f.controls.pumpDue();
  let second: Promise<void> | undefined;
  try {
    await gate.reached;
    const claimed = await author.getSchedule(job.data.id);
    expect(claimed.data).toMatchObject({ status: "running", message_id: null });
    expect(created(f)).toEqual([]);
    second = f.controls.pumpDue();
    await refuses(
      f,
      () => author.sendScheduleNow(job.data.id, { if_match: claimed.etag }),
      409,
      "comms_schedule_claimed",
    );
    await refuses(
      f,
      () => author.cancelSchedule(job.data.id, { if_match: claimed.etag }),
      409,
      "comms_schedule_claimed",
    );
    await refuses(
      f,
      () =>
        author.updateSchedule(job.data.id, schedule(f, 203), {
          if_match: claimed.etag,
        }),
      409,
      "comms_schedule_claimed",
    );
  } finally {
    gate.release();
    await Promise.all([first, ...(second ? [second] : [])]);
  }
  const done = (await author.getSchedule(job.data.id)).data;
  expect(done.status).toBe("succeeded");
  expect(created(f)).toHaveLength(1);
  expect(
    (await author.getMessage(f.channelId, done.message_id!)).data,
  ).toMatchObject({
    parent_id: f.rootId,
    reply_to_id: f.rootId,
    also_send_to_channel: true,
    client_key: id(203),
    author_id: f.context.user_id,
    body: "Scheduled reply",
    seq: 3,
  });
  expect((await author.getThread(f.channelId, f.rootId)).data).toMatchObject({
    id: f.threadId,
    reply_count: 2,
  });
  expect(
    (await author.getReplies(f.channelId, f.rootId)).items.map((m) => m.seq),
  ).toEqual([2, 3]);
  expect(
    (await author.getHistory(f.channelId)).items.map((m) => m.seq),
  ).toEqual([1, 3]);
});

for (const entry of ["send-now", "pump"] as const) {
  test(`ID28 ${entry} caller abort after claim cancels only the wait`, async ({
    make,
  }) => {
    const gate = barrier(),
      f = make({ beforeScheduleSend: gate.hold }),
      author = f.as();
    const request = schedule(f, 222, {
      body: "Resource-owned dispatch after caller abort",
    });
    const job = await author.createSchedule(request);
    f.advance(60_000);
    const start = (signal: AbortSignal) =>
      entry === "send-now"
        ? author.sendScheduleNow(job.data.id, { if_match: job.etag, signal })
        : f.controls.pumpDue({ signal });
    const terminal = deferred<ReturnType<typeof f.store.exportSnapshot>>();
    const stop = f.store.subscribe(() => {
      const snapshot = f.store.exportSnapshot();
      const row = snapshot.state.schedules[job.data.id];
      if (row && row.status !== "pending" && row.status !== "running")
        terminal.resolve(snapshot);
    });
    const caller = new AbortController();
    try {
      await test.step("pre-claim abort leaves this job pending and unchanged", async () => {
        const before = f.store.exportSnapshot();
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(start(cancelled.signal)).rejects.toMatchObject({
          kind: "cancelled",
        });
        expect(f.store.exportSnapshot()).toEqual(before);
        expect((await author.getSchedule(job.data.id)).data.status).toBe(
          "pending",
        );
        expect(created(f)).toEqual([]);
      });

      const waiting = start(caller.signal);
      void waiting.catch(() => undefined); // Cleanup must not introduce an unhandled rejection.
      await test.step("real send barrier follows a committed running claim", async () => {
        await gate.reached;
        expect((await author.getSchedule(job.data.id)).data).toMatchObject({
          status: "running",
          message_id: null,
          failure_code: null,
        });
        expect(f.store.exportSnapshot().state.high_water_seq[f.channelId]).toBe(
          2,
        );
        expect(created(f)).toEqual([]);
      });
      const claimed = f.store.exportSnapshot();
      await test.step("caller wait cancels while the send gate stays closed", async () => {
        caller.abort();
        await expect(waiting).rejects.toMatchObject({ kind: "cancelled" });
        expect(f.store.exportSnapshot()).toEqual(claimed);
        expect((await author.getSchedule(job.data.id)).data.status).toBe(
          "running",
        );
        expect(created(f)).toEqual([]);
      });

      gate.release();
      // Observe actual completion, not a sleep, flush helper or replacement pump.
      const completed =
        await test.step("released claimed job reaches a terminal store commit", () =>
          terminal.promise);
      const done = completed.state.schedules[job.data.id];
      expect(done).toMatchObject({ status: "succeeded", failure_code: null });
      expect(done.message_id).not.toBeNull();
      expect(
        Object.values(completed.state.messages).filter(
          (message) => message.client_key === request.client_key,
        ),
      ).toEqual([
        expect.objectContaining({
          id: done.message_id,
          client_key: request.client_key,
          body: request.body,
          author_id: f.context.user_id,
          conversation_id: f.channelId,
          seq: 3,
        }),
      ]);
      expect(completed.state.high_water_seq[f.channelId]).toBe(3);
      expect((await author.getSchedule(job.data.id)).data).toEqual(done);
      expect(created(f)).toHaveLength(1);
      const deliveries = structuredClone(f.deliveries);
      await f.controls.pumpDue();
      expect(f.store.exportSnapshot()).toEqual(completed);
      expect(f.deliveries).toEqual(deliveries);
      expect(created(f)).toHaveLength(1);
    } finally {
      stop();
      caller.abort();
      gate.release();
      f.close();
    }
  });
}

for (const cause of ["access_lost", "post_denied", "unavailable"] as const) {
  test(`claimed schedule rechecks ${cause} and commits only a finite failure`, async ({
    make,
  }) => {
    const gate = barrier(),
      f = make({ beforeScheduleSend: gate.hold }),
      author = f.as();
    const job = await author.createSchedule(schedule(f, 204));
    f.advance(60_000);
    const pumping = f.controls.pumpDue();
    try {
      await gate.reached;
      if (cause === "access_lost") {
        // D44 access loss: the author's department role ends in Access.
        await f.handle(f.managerId).command({
          authorize() {},
          apply(draft) {
            draft.people[f.context.user_id].department_levels = {};
            return {
              kind: "commit",
              value: undefined,
              version_keys: [],
              publications: [],
            };
          },
        });
      } else if (cause === "post_denied") await settings(f, { locked: true });
      else f.store.failNextCommit();
    } finally {
      gate.release();
      await pumping;
    }
    expect((await author.getSchedule(job.data.id)).data).toMatchObject({
      status: "failed",
      failure_code: cause,
      message_id: null,
    });
    expect(f.store.exportSnapshot().state.high_water_seq[f.channelId]).toBe(2);
    expect(Object.keys(f.store.exportSnapshot().state.messages).sort()).toEqual(
      [f.rootId, f.replyId].sort(),
    );
    expect(f.store.exportSnapshot().state.idempotency).toEqual({});
    expect(created(f)).toEqual([]);
    await f.controls.pumpDue();
    expect((await author.getSchedule(job.data.id)).data.status).toBe("failed");
    expect(created(f)).toEqual([]);
  });
}

test("ID26 owner refusal stays actor-local for unbound scheduled authors and later client binding", async ({
  make,
}) => {
  const f = make({
    prepare(data) {
      // Canonical pending jobs precede all family/dependency bindings, especially peer's.
      for (const [n, authorId, body] of [
        [208, data.context.user_id, "Owner-targeted job"],
        [209, data.peerId, "Previously unbound peer job"],
      ] as const) {
        data.initial.schedules[id(n)] = {
          id: id(n),
          org_id: data.context.org_id,
          author_id: authorId,
          created_at: iso(),
          updated_at: iso(),
          status: "pending",
          message_id: null,
          failure_code: null,
          request: {
            conversation_id: data.channelId,
            client_key: id(n + 10),
            body,
            send_at: iso(now + 60_000),
            parent_id: null,
            reply_to_id: null,
            also_send_to_channel: false,
            attachment_ids: [],
            record_ids: [],
            mention_user_ids: [],
            mentions_channel: true,
            mentions_here: false,
          },
        };
      }
    },
  });
  const owner = f.as(),
    manager = f.as(f.managerId);
  const scope = { kind: "channel", id: f.channelId } as const;
  const groupId = f.initial.people[f.context.user_id].group_ids[0];
  const current = await manager.getCapabilityConfiguration(scope);
  await manager.setCapabilityConfiguration(
    {
      ...current.data,
      group_grants: [
        ...current.data.group_grants,
        { group_id: groupId, capability: "mentionChannel" },
      ],
    },
    { if_match: current.etag },
  );
  const granted = {
    allowed: true,
    source: { kind: "group_grant", scope, group_id: groupId },
  };
  expect(
    (await owner.getCapabilities(f.channelId)).capabilities.mentionChannel,
  ).toMatchObject(granted);
  // Inspection as manager proves peer's real rights without composing peer's client.
  expect(await manager.checkPerson(f.channelId, f.peerId)).toMatchObject({
    user_id: f.peerId,
    membership_role: "member",
    conversation_level: "post",
    manager_source: null,
    capabilities: { mentionChannel: granted },
  });
  f.ownerAvailabilityControls.denyCapability({
    scope,
    capability: "mentionChannel",
  });
  // No as(peer), binding(peer), or sendDependenciesFor(peerHandle) before this pump.
  f.advance(60_000);
  await f.controls.pumpDue();
  const dispatched = f.store.exportSnapshot().state;
  expect(dispatched.schedules[id(208)]).toMatchObject({
    author_id: f.context.user_id,
    status: "failed",
    message_id: null,
  });
  expect(dispatched.schedules[id(208)].failure_code).not.toBeNull();
  expect(dispatched.schedules[id(209)]).toMatchObject({
    author_id: f.peerId,
    status: "succeeded",
    failure_code: null,
  });
  const peerMessageId = dispatched.schedules[id(209)].message_id;
  expect(peerMessageId).not.toBeNull();
  expect(
    (await owner.getMessage(f.channelId, peerMessageId!)).data,
  ).toMatchObject({
    author_id: f.peerId,
    client_key: id(219),
    body: "Previously unbound peer job",
    seq: 3,
    mentions_channel: true,
  });
  expect(
    Object.values(dispatched.messages).filter((m) => m.client_key === id(218)),
  ).toEqual([]);
  expect(dispatched.high_water_seq[f.channelId]).toBe(3);
  expect(created(f)).toHaveLength(1);

  // Both handles and all peer dependency lookups are deliberately AFTER dispatch.
  const peerContext = { ...f.context, user_id: f.peerId };
  const firstHandle = f.store.bind(peerContext),
    secondHandle = f.store.bind(peerContext);
  try {
    const dependencies = f.controls.sendDependenciesFor(firstHandle);
    expect(f.controls.sendDependenciesFor(secondHandle)).toBe(dependencies);
    expect(dependencies).not.toBe(f.controls.sendDependencies);
    const peer = f.as(f.peerId);
    expect(f.controls.sendDependenciesFor(f.handle(f.peerId))).toBe(
      dependencies,
    );
    expect(f.binding(f.peerId).authority).toBe(dependencies.authority);
    expect(
      (await peer.getCapabilities(f.channelId)).capabilities.mentionChannel,
    ).toMatchObject(granted);
    expect(
      await peer.sendMessage(f.channelId, {
        client_key: id(220),
        body: "Peer ordinary send after dispatch",
        mentions_channel: true,
      }),
    ).toMatchObject({
      status: 201,
      message: { author_id: f.peerId, seq: 4, mentions_channel: true },
    });
    await refuses(
      f,
      () =>
        owner.sendMessage(f.channelId, {
          client_key: id(221),
          body: "Owner remains refused",
          mentions_channel: true,
        }),
      403,
      "comms_capability_denied",
    );
    expect(
      (await peer.getHistory(f.channelId)).items.map((message) => message.seq),
    ).toEqual([1, 3, 4]);
    expect(created(f)).toHaveLength(2);
  } finally {
    firstHandle.dispose();
    secondHandle.dispose();
  }
});

test("pending schedule reload completes once and a completed snapshot does not run again", async ({
  make,
}) => {
  const first = make();
  const pending = await first.as().createSchedule(schedule(first, 205));
  const snapshot = first.store.exportSnapshot();
  first.close();
  const restored = make({ snapshot });
  expect((await restored.as().getSchedule(pending.data.id)).data.status).toBe(
    "pending",
  );
  restored.advance(60_000);
  await restored.controls.pumpDue();
  expect(created(restored)).toHaveLength(1);
  const completed = restored.store.exportSnapshot();
  restored.close();
  const again = make({ snapshot: completed });
  again.advance(120_000);
  await again.controls.pumpDue();
  expect((await again.as().getSchedule(pending.data.id)).data.status).toBe(
    "succeeded",
  );
  expect(created(again)).toEqual([]);
  expect(
    again.store.exportSnapshot().state.high_water_seq[again.channelId],
  ).toBe(3);
});

test("reset cancels an already claimed pump even when its barrier ignores the signal", async ({
  make,
}) => {
  const gate = barrier(),
    f = make({ beforeScheduleSend: gate.hold });
  await upload(f);
  await f.as().heartbeatPresence({ state: "online" });
  await f.as().sendTyping(f.channelId);
  await f.as().createSchedule(schedule(f, 206));
  f.advance(60_000);
  const result = f.controls.pumpDue().then(
    () => ({ kind: "resolved" }),
    (error: unknown) => error,
  );
  try {
    await gate.reached;
    const deliveries = structuredClone(f.deliveries);
    f.store.reset();
    expect(await result).toMatchObject({ kind: "cancelled" });
    await expect(f.controls.expireTransient()).rejects.toMatchObject({
      kind: "cancelled",
    });
    const rebound = f.store.bind(f.context);
    try {
      expect(
        caught(() =>
          createOperationalFamily(
            { handle: rebound, authority: f.authority },
            f.controls,
          ),
        ),
      ).toMatchObject({ kind: "cancelled" });
      expect(
        caught(() =>
          createMessageFamily(
            { handle: rebound, authority: f.authority },
            f.controls.sendDependencies,
          ),
        ),
      ).toMatchObject({ kind: "cancelled" });
      expect(
        caught(() =>
          createOperationalResources(f.store, {
            files: f.files,
            clock: f.clock,
            ownerBinding: { handle: rebound, authority: f.authority },
          }),
        ),
      ).toMatchObject({ kind: "cancelled" });
    } finally {
      rebound.dispose();
    }
    gate.release();
    // One event-loop checkpoint after explicit release, not a time-based sleep.
    // Allows ignored-signal preparation continuations to attempt their late work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.store.exportSnapshot().state.schedules).toEqual({});
    expect(f.store.exportSnapshot().state.high_water_seq[f.channelId]).toBe(2);
    expect(f.deliveries).toEqual(deliveries);
  } finally {
    gate.release();
  }
});

test("presence is org-wide including guests, D36-filtered, transient and expires on the injected clock", async ({
  make,
}) => {
  const f = make(),
    foreign = make({ offset: 1000 });
  const original = structuredClone(f.store.exportSnapshot());
  const peer = f.as(f.peerId);
  const observed: ReturnType<typeof peer.getPresence>[] = [];
  const stop = f.handle(f.peerId).events.subscribe({
    on_event: (event) => {
      if (
        event.event !== "presence" ||
        event.payload.user_id !== f.context.user_id
      )
        return;
      // Real snapshot invocation on the same event turn; assertions outside swallowed callbacks.
      const snapshot = peer.getPresence({ user_ids: [f.context.user_id] });
      void snapshot.catch(() => undefined);
      observed.push(snapshot);
    },
    on_connection: () => {},
    on_error: () => {},
  });
  await f.as().heartbeatPresence({ state: "online" }).finally(stop);
  expect(await Promise.all(observed)).toEqual([
    {
      org_id: f.context.org_id,
      items: [{ user_id: f.context.user_id, state: "online" }],
    },
  ]);
  const online = {
    private: true,
    topic: `org:${f.context.org_id}:presence`,
    event: "presence",
    payload: { user_id: f.context.user_id, state: "online" },
  };
  expect(f.events(f.guestId)).toEqual([online]);
  expect(f.events(f.outsiderId)).toEqual([online]); // D35 topic, not conversation membership.
  expect(foreign.deliveries).toEqual([]);
  await f.as().heartbeatPresence({ state: "online" });
  expect(f.events(f.guestId)).toEqual([online]);
  f.store.failNextCommit();
  await refuses(
    f,
    () => f.as().heartbeatPresence({ state: "away" }),
    503,
    "comms_unavailable",
  );
  expect(await peer.getPresence({ user_ids: [f.context.user_id] })).toEqual({
    org_id: f.context.org_id,
    items: [{ user_id: f.context.user_id, state: "online" }],
  });
  await f.as(f.guestId).heartbeatPresence({ state: "away" });
  const snapshot = await f.as(f.peerId).getPresence({
    user_ids: [
      f.context.user_id,
      f.guestId,
      f.outsiderId,
      foreign.context.user_id,
    ],
  });
  expect(snapshot.org_id).toBe(f.context.org_id);
  expect(
    snapshot.items.sort((a, b) => a.user_id.localeCompare(b.user_id)),
  ).toEqual(
    [
      { user_id: f.context.user_id, state: "online" },
      { user_id: f.guestId, state: "away" },
    ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
  );
  expect(
    await foreign.as(f.guestId).getPresence({ user_ids: [f.guestId] }),
  ).toEqual({
    org_id: foreign.context.org_id,
    items: [{ user_id: f.guestId, state: "offline" }],
  });
  await f.as().heartbeatPresence({ state: "away" });
  f.advance(119_999);
  await f.controls.expireTransient();
  expect(
    (await f.as(f.guestId).getPresence({ user_ids: [f.context.user_id] }))
      .items,
  ).toEqual([{ user_id: f.context.user_id, state: "away" }]);
  f.advance(1);
  await f.controls.expireTransient();
  expect(
    (await f.as(f.guestId).getPresence({ user_ids: [f.context.user_id] }))
      .items,
  ).toEqual([{ user_id: f.context.user_id, state: "offline" }]);
  expect(
    f
      .events(f.guestId)
      .filter(
        (e) =>
          e.event === "presence" && e.payload.user_id === f.context.user_id,
      ),
  ).toEqual([
    online,
    { ...online, payload: { user_id: f.context.user_id, state: "away" } },
    { ...online, payload: { user_id: f.context.user_id, state: "offline" } },
  ]);
  expect(f.store.exportSnapshot()).toEqual(original);
});

test("typing uses current post access, refuses guests and expires without content-bearing events", async ({
  make,
}) => {
  const f = make({
    prepare(data) {
      const channel = data.initial.conversations[data.channelId];
      if (channel.kind !== "channel") throw new Error("Expected channel");
      const groupId = data.initial.people[data.context.user_id].group_ids[0];
      data.initial.configuration[`channel:${data.channelId}`] = {
        settings: {},
        capabilities: {
          scope: { kind: "channel", id: data.channelId },
          everyone: {},
          group_grants: [{ group_id: groupId, capability: "reply" }],
        },
      };
    },
  });
  const original = structuredClone(f.store.exportSnapshot());
  expect(await f.as().sendTyping(f.channelId)).toBeUndefined();
  expect(f.events(f.peerId)).toEqual([
    {
      topic: `org:${f.context.org_id}:conversation:${f.channelId}`,
      private: true,
      event: "typing",
      payload: { conversation_id: f.channelId, user_id: f.context.user_id },
    },
  ]);
  expect(f.events(f.outsiderId)).toEqual([]);
  expect(f.controls.typingFor(f.handle(f.peerId), f.channelId)).toEqual([
    f.context.user_id,
  ]);
  await refuses(
    f,
    () => f.as(f.guestId).sendTyping(f.channelId),
    403,
    "comms_post_denied",
  );
  f.advance(15_000);
  await f.controls.expireTransient();
  expect(f.controls.typingFor(f.handle(f.peerId), f.channelId)).toEqual([]);
  expect(f.store.exportSnapshot()).toEqual(original);
  await f.as().sendTyping(f.channelId);
  // The reporter's department role drops to read (D44: roles change in Access).
  await f.handle(f.managerId).command({
    authorize() {},
    apply(draft) {
      const room = draft.conversations[f.channelId];
      if (room.kind !== "channel" || room.scope !== "department")
        throw new Error("Expected a department channel");
      draft.people[f.context.user_id].department_levels[room.department_id] =
        "read";
      return {
        kind: "commit",
        value: undefined,
        version_keys: [],
        publications: [],
      };
    },
  });
  expect(
    (await f.as().getCapabilities(f.channelId)).capabilities.reply.allowed,
  ).toBe(true);
  await refuses(
    f,
    () => f.as().sendTyping(f.channelId),
    403,
    "comms_post_denied",
  );
  await f.controls.expireTransient();
  expect(f.controls.typingFor(f.handle(f.peerId), f.channelId)).toEqual([]);
});

test("handle sign-out and store disposal retire transient activity instead of restoring it", async ({
  make,
}) => {
  const f = make();
  const other = make(); // Same owner/seed; exact store identity must still differ.
  expect(f.files.store).toBe(f.store);
  expect(f.controls.store).toBe(f.store);
  expect(f.controls.sendDependencies.store).toBe(f.store);
  expect(f.controls.sendDependencies.files).toBe(f.files);
  expect(f.controls.sendDependencies.presence).toBe(f.controls);
  expect(
    caught(() =>
      createMessageFamily(f.binding(), other.controls.sendDependencies),
    ),
  ).toMatchObject({ kind: "invalid_response" });
  expect(
    caught(() => createOperationalFamily(f.binding(), other.controls)),
  ).toMatchObject({ kind: "invalid_response" });
  expect(
    caught(() =>
      createOperationalResources(f.store, {
        files: other.files,
        clock: f.clock,
        ownerBinding: f.ownerBinding,
      }),
    ),
  ).toMatchObject({ kind: "invalid_response" });
  const peerFile = await upload(f, f.peerId);
  await f.as(f.peerId).heartbeatPresence({ state: "online" });
  await f.as(f.peerId).sendTyping(f.privateId);
  await f.as().heartbeatPresence({ state: "online" });
  await f.as().sendTyping(f.channelId);
  const snapshot = f.store.exportSnapshot();
  f.handle().dispose(); // Real lifecycle boundary, not fixture edits to an activity map.
  await f.controls.expireTransient();
  expect(f.controls.typingFor(f.handle(f.peerId), f.channelId)).toEqual([]);
  expect(
    (await f.as(f.peerId).getPresence({ user_ids: [f.context.user_id] })).items,
  ).toEqual([{ user_id: f.context.user_id, state: "offline" }]);
  expect(
    (await f.as(f.managerId).getPresence({ user_ids: [f.peerId] })).items,
  ).toEqual([{ user_id: f.peerId, state: "online" }]);
  expect(f.controls.typingFor(f.handle(f.managerId), f.privateId)).toEqual([
    f.peerId,
  ]);
  expect(
    await f.as(f.peerId).downloadAttachment(f.channelId, peerFile.id),
  ).toMatchObject({ filename: "dispatch.png", media_type: "image/png" });
  const deliveries = structuredClone(f.deliveries);
  await expect(
    f.as().heartbeatPresence({ state: "online" }),
  ).rejects.toMatchObject({ kind: "cancelled" });
  expect(f.deliveries).toEqual(deliveries);
  f.store.dispose(); // Raw boundary: do not pre-close operational or file resources.
  await expect(f.controls.expireTransient()).rejects.toMatchObject({
    kind: "cancelled",
  });
  f.close();
  const restored = make({ snapshot });
  expect(
    (
      await restored
        .as(f.peerId)
        .getPresence({ user_ids: [restored.context.user_id] })
    ).items,
  ).toEqual([{ user_id: restored.context.user_id, state: "offline" }]);
  expect(
    restored.controls.typingFor(
      restored.handle(restored.peerId),
      restored.channelId,
    ),
  ).toEqual([]);
});

test("scheduled @here uses send-time online members and replay never notifies again", async ({
  make,
}) => {
  const gate = barrier(),
    f = make({ beforeScheduleSend: gate.hold }),
    author = f.as(f.managerId);
  const a = f.as(),
    b = f.as(f.peerId); // Manager author already has the real mentionChannel capability.
  await a.heartbeatPresence({ state: "online" });
  expect(
    (
      await author.getPresence({ user_ids: [f.context.user_id, f.peerId] })
    ).items.sort((x, y) => x.user_id.localeCompare(y.user_id)),
  ).toEqual(
    [
      { user_id: f.context.user_id, state: "online" },
      { user_id: f.peerId, state: "offline" },
    ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
  );
  const content = {
    client_key: id(207),
    body: "Notify whoever is here at dispatch",
    mentions_here: true,
  };
  const job = await author.createSchedule(schedule(f, 207, content));
  f.advance(60_000);
  const pumping = f.controls.pumpDue();
  try {
    await gate.reached; // After claim, still before synchronous send apply.
    f.advance(60_000); // A's last heartbeat is now 120s old; offline is server-originated.
    await f.controls.expireTransient();
    await b.heartbeatPresence({ state: "online" });
    expect(
      (
        await author.getPresence({ user_ids: [f.context.user_id, f.peerId] })
      ).items.sort((x, y) => x.user_id.localeCompare(y.user_id)),
    ).toEqual(
      [
        { user_id: f.context.user_id, state: "offline" },
        { user_id: f.peerId, state: "online" },
      ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
    );
    expect(created(f)).toEqual([]);
  } finally {
    gate.release();
    await pumping;
  }
  const done = (await author.getSchedule(job.data.id)).data;
  expect(done).toMatchObject({ status: "succeeded", failure_code: null });
  expect(done.message_id).not.toBeNull();
  const message = (await author.getMessage(f.channelId, done.message_id!)).data;
  expect(message).toMatchObject({
    client_key: id(207),
    seq: 3,
    mentions_here: true,
  });
  const mentionRecipients = Object.entries(
    f.store.exportSnapshot().state.users,
  ).flatMap(([userId, user]) =>
    user.notifications
      .filter(
        (n) => n.message_id === done.message_id && n.kind === "comms-mention",
      )
      .map(() => userId),
  );
  expect(mentionRecipients).toEqual([f.peerId]);
  expect(created(f)).toHaveLength(1);
  const notifications = Object.fromEntries(
    Object.entries(f.store.exportSnapshot().state.users).map(
      ([userId, user]) => [userId, user.notifications],
    ),
  );
  f.advance(120_000);
  await f.controls.expireTransient(); // B expires; replay now sees a different online population.
  await a.heartbeatPresence({ state: "online" });
  expect(await author.sendMessage(f.channelId, content)).toMatchObject({
    status: 200,
    message: { id: done.message_id, seq: 3 },
  });
  await f.controls.pumpDue();
  expect(
    Object.fromEntries(
      Object.entries(f.store.exportSnapshot().state.users).map(
        ([userId, user]) => [userId, user.notifications],
      ),
    ),
  ).toEqual(notifications);
  expect(f.store.exportSnapshot().state.high_water_seq[f.channelId]).toBe(3);
  expect(created(f)).toHaveLength(1);
});
