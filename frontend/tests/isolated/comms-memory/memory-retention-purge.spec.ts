/** PROMOTED / UNRUN — real method-family transitions; no proof implementation here. */
import type * as C from "@/components/systems/comms/contract/types";
import {
  test,
  expect,
  marker,
  start,
  workspace,
  putRetention,
  refuses,
  failure,
  upload,
  send,
  deferred,
  changeAuthority,
  noPrivateMaterial,
} from "./memory-protected-fixture";

test("retention preview is nonmutating and null inheritance stays distinct from forever", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  const current = await client.getRetention(workspace);
  expect(current.data.effective).toEqual({ message_days: 0, file_days: 0 });
  const before = f.store.exportSnapshot();
  const policy = { scope: workspace, message_days: 30, file_days: 30 };
  const preview = await client.previewRetention(policy, {
    if_match: current.etag,
    password: marker,
  });
  expect(preview).toMatchObject({
    policy,
    effective: { message_days: 30, file_days: 30 },
    message_count: 2,
    file_count: 1,
  });
  expect(f.store.exportSnapshot()).toEqual(before);
  await client.updateRetention(
    { ...policy, preview_digest: preview.preview_digest },
    { if_match: current.etag, password: marker },
  );
  const local = await putRetention(f, {
    scope: f.channelScope,
    message_days: 7,
    file_days: 0,
  });
  expect(local.data).toMatchObject({
    effective: { message_days: 7, file_days: 0 },
    sources: { message_days: "channel", file_days: "channel" },
  });
  const inherited = await putRetention(f, {
    scope: f.channelScope,
    message_days: null,
    file_days: 0,
  });
  expect(inherited.data.effective).toEqual({ message_days: 30, file_days: 0 });
  await putRetention(f, { scope: workspace, message_days: 60, file_days: 60 });
  expect((await client.getRetention(f.channelScope)).data).toEqual({
    policy: { scope: f.channelScope, message_days: null, file_days: 0 },
    effective: { message_days: 60, file_days: 0 },
    sources: { message_days: "workspace", file_days: "channel" },
  });
  // A policy update is not a new retention worker or an immediate delete command.
  expect(f.store.exportSnapshot().state.messages).toEqual(
    before.state.messages,
  );
  expect(f.store.exportSnapshot().state.files).toEqual(before.state.files);
  noPrivateMaterial(f.store.exportSnapshot());
});

test("retention apply refuses stale inherited policy and new message or file collection witnesses", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  await putRetention(f, { scope: workspace, message_days: 30, file_days: 30 });
  const policy = { scope: f.channelScope, message_days: null, file_days: null };
  const first = await client.getRetention(f.channelScope);
  const inherited = await client.previewRetention(policy, {
    if_match: first.etag,
    password: marker,
  });
  await putRetention(f, { scope: workspace, message_days: 60, file_days: 60 });
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, preview_digest: inherited.preview_digest },
        { if_match: first.etag, password: marker },
      ),
    412,
    "comms_precondition_failed",
  );
  const current = await client.getRetention(f.channelScope);
  const messages = await client.previewRetention(policy, {
    if_match: current.etag,
    password: marker,
  });
  await client.sendMessage(f.channelId, send("Arrived after preview", 101));
  // No old message or policy row changed: checking only captured row versions fails.
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, preview_digest: messages.preview_digest },
        { if_match: current.etag, password: marker },
      ),
    412,
    "comms_precondition_failed",
  );
  const next = await client.getRetention(f.channelScope);
  const files = await client.previewRetention(policy, {
    if_match: next.etag,
    password: marker,
  });
  await upload(f);
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, preview_digest: files.preview_digest },
        { if_match: next.etag, password: marker },
      ),
    412,
    "comms_precondition_failed",
  );
  const accepted = await putRetention(f, policy);
  expect(accepted.data.effective).toEqual({ message_days: 60, file_days: 60 });
});

test("real sample confirmation refuses arbitrary text and preview correlation cannot authorize another proposal or actor", async ({
  make,
}) => {
  const f = make({
    prepare(s) {
      s.peer.role = "admin";
    },
  });
  const client = f.as();
  const current = await client.getRetention(workspace);
  const policy = { scope: workspace, message_days: 30, file_days: 0 };
  await refuses(
    f,
    () =>
      f
        .as(f.actorId)
        .previewRetention(policy, { if_match: current.etag, password: marker }),
    403,
    "comms_admin_required",
  );
  await refuses(
    f,
    () =>
      client.previewRetention(policy, {
        if_match: current.etag,
        password: "ordinary text",
      }),
    403,
    "comms_fresh_admin_required",
  );
  await refuses(
    f,
    () =>
      client.previewRetention(policy, {
        password: marker,
      } as C.ConditionalOptions & C.FreshAdminOptions),
    428,
    "comms_precondition_required",
  );
  const preview = await client.previewRetention(policy, {
    if_match: current.etag,
    password: marker,
  });
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, message_days: 1, preview_digest: preview.preview_digest },
        { if_match: current.etag, password: marker },
      ),
    409,
    "comms_conflict",
  );
  await refuses(
    f,
    () =>
      f
        .as(f.peer.user_id)
        .updateRetention(
          { ...policy, preview_digest: preview.preview_digest },
          { if_match: current.etag, password: marker },
        ),
    409,
    "comms_conflict",
  );
  // Preview success never waives confirmation for this separate apply invocation.
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, preview_digest: preview.preview_digest },
        { if_match: current.etag, password: "ordinary text" },
      ),
    403,
    "comms_fresh_admin_required",
  );
  const result = await client.updateRetention(
    { ...policy, preview_digest: preview.preview_digest },
    { if_match: current.etag, password: marker },
  );
  expect(result.data.effective.message_days).toBe(30);
  noPrivateMaterial(result);
  noPrivateMaterial(f.store.exportSnapshot());
});

test("freshness starts at invocation and delayed verification cannot renew time or retain a lost admin role", async ({
  make,
}) => {
  let verify = async (): Promise<unknown> => true;
  const f = make({ verifyConfirmation: () => verify() });
  const client = f.as();
  const current = await client.getRetention(workspace);
  const policy = { scope: workspace, message_days: 30, file_days: 0 };
  const request = () =>
    client.previewRetention(policy, {
      if_match: current.etag,
      password: marker,
    });
  const entered = deferred<void>();
  const answer = deferred<unknown>();
  verify = () => {
    entered.resolve();
    return answer.promise;
  };
  const expired = request();
  const expiredAssertion = failure(expired, 403, "comms_fresh_admin_required");
  await entered.promise;
  f.advance(60_000); // Boundary, not a sleep. Lifetime is strictly less than 60s.
  answer.resolve(true);
  await expiredAssertion;
  expect(f.store.exportSnapshot().state.retention.workspace.message_days).toBe(
    0,
  );

  const rollbackEntered = deferred<void>();
  const rollbackAnswer = deferred<unknown>();
  verify = () => {
    rollbackEntered.resolve();
    return rollbackAnswer.promise;
  };
  const rollback = request();
  const rollbackAssertion = failure(
    rollback,
    403,
    "comms_fresh_admin_required",
  );
  await rollbackEntered.promise;
  f.advance(-1);
  rollbackAnswer.resolve(true);
  await rollbackAssertion;

  const roleEntered = deferred<void>();
  const roleAnswer = deferred<unknown>();
  verify = () => {
    roleEntered.resolve();
    return roleAnswer.promise;
  };
  const role = request();
  const roleAssertion = failure(role, 403, "comms_admin_required");
  await roleEntered.promise;
  await changeAuthority(f, (state) => {
    state.people[f.adminId].role = "member";
  });
  roleAnswer.resolve(true);
  await roleAssertion;
  await changeAuthority(f, (state) => {
    state.people[f.adminId].role = "admin";
  });
  verify = async () => false;
  await refuses(f, request, 403, "comms_fresh_admin_required");
  verify = async () => {
    throw Object.assign(new Error("Synthetic unavailable verifier"), {
      kind: "http",
      failure: {
        status: 503,
        body: { detail: { code: "comms_unavailable", message: "Unavailable" } },
      },
    });
  };
  await refuses(f, request, 503, "comms_unavailable");
  verify = async () => ({ accepted: true });
  const before = f.store.exportSnapshot();
  const events = structuredClone(f.events);
  await expect(request()).rejects.toMatchObject({ kind: "invalid_response" });
  expect(f.store.exportSnapshot()).toEqual(before);
  expect(f.events).toEqual(events);
});

test("cancelled tool preparation cannot install late previews and the bounded registry expires across reset", async ({
  make,
}) => {
  const entered = deferred<void>();
  const answer = deferred<unknown>();
  let held = true;
  const f = make({
    verifyConfirmation: async () => {
      if (held) {
        entered.resolve();
        return answer.promise;
      }
      return true;
    },
  });
  const client = f.as();
  const current = await client.getRetention(workspace);
  const policy = { scope: workspace, message_days: 30, file_days: 0 };
  const abort = new AbortController();
  const pending = client.previewRetention(policy, {
    if_match: current.etag,
    password: marker,
    signal: abort.signal,
  });
  const cancelled = expect(pending).rejects.toMatchObject({
    kind: "cancelled",
  });
  await entered.promise;
  abort.abort();
  await cancelled; // MUST settle before verifier release; await-then-command hangs.
  held = false;
  const surviving: C.RetentionPreview[] = [];
  for (let index = 0; index < 32; index += 1)
    surviving.push(
      await client.previewRetention(policy, {
        if_match: current.etag,
        password: marker,
      }),
    );
  answer.resolve(true);
  // A late installation would become entry 33 and evict this still-live handle.
  // Its successful use detects that private leak without inspecting the registry.
  const accepted = await client.updateRetention(
    { ...policy, preview_digest: surviving[0].preview_digest },
    { if_match: current.etag, password: marker },
  );
  const previews: C.RetentionPreview[] = [];
  for (let index = 0; index < 33; index += 1)
    previews.push(
      await client.previewRetention(policy, {
        if_match: accepted.etag,
        password: marker,
      }),
    );
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, preview_digest: previews[0].preview_digest },
        { if_match: accepted.etag, password: marker },
      ),
    409,
    "comms_conflict",
  );
  // All 32 remaining entries were issued at the same injected instant.
  f.setTime(start + 60_000);
  await refuses(
    f,
    () =>
      client.updateRetention(
        { ...policy, preview_digest: previews[32].preview_digest },
        { if_match: accepted.etag, password: marker },
      ),
    409,
    "comms_conflict",
  );
  const live = await client.previewRetention(policy, {
    if_match: accepted.etag,
    password: marker,
  });
  const resetEntered = deferred<void>();
  // Same verifier seam now ignores cancellation in an old-store generation.
  // A separate fixture avoids replacing any production verifier after construction.
  const resetAnswer = deferred<unknown>();
  const resetFixture = make({
    verifyConfirmation: () => {
      resetEntered.resolve();
      return resetAnswer.promise;
    },
  });
  const oldClient = resetFixture.as();
  const oldTag = (await oldClient.getRetention(workspace)).etag;
  const resetPending = oldClient.previewRetention(policy, {
    if_match: oldTag,
    password: marker,
  });
  const resetCancelled = expect(resetPending).rejects.toMatchObject({
    kind: "cancelled",
  });
  await resetEntered.promise;
  resetFixture.reset();
  await resetCancelled;
  resetAnswer.resolve(true);
  expect(
    (await resetFixture.as().getRetention(workspace)).data.effective
      .message_days,
  ).toBe(0);
  f.reset();
  const reset = f.as();
  const newTag = (await reset.getRetention(workspace)).etag;
  await refuses(
    f,
    () =>
      reset.updateRetention(
        { ...policy, preview_digest: live.preview_digest },
        { if_match: newTag, password: marker },
      ),
    409,
    "comms_conflict",
  );
  expect((await putRetention(f, policy)).data.effective.message_days).toBe(30);

  // A disposed bound client must not bind a new handle after ignored verification.
  const disposalEntered = deferred<void>();
  const disposalAnswer = deferred<unknown>();
  const g = make({
    verifyConfirmation: () => {
      disposalEntered.resolve();
      return disposalAnswer.promise;
    },
  });
  const gClient = g.as();
  const gTag = (await gClient.getRetention(workspace)).etag;
  const late = gClient.previewRetention(policy, {
    if_match: gTag,
    password: marker,
  });
  const disposed = expect(late).rejects.toMatchObject({ kind: "cancelled" });
  await disposalEntered.promise;
  g.close();
  await disposed;
  disposalAnswer.resolve(true);
  await expect(gClient.getRetention(workspace)).rejects.toMatchObject({
    kind: "cancelled",
  });
});

test("purge challenge binds count max-seq name and owned content without inventing a backup gate", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  const ownedFile = await upload(f);
  const siblingFile = await upload(f, f.otherId);
  const siblingDownload = await client.downloadAttachment(
    f.otherId,
    siblingFile.id,
  );
  const room = await client.getConversation(f.channelId);
  await client.archiveConversation(f.channelId, { if_match: room.etag });
  const before = f.store.exportSnapshot();
  const preview = await client.previewPurge(f.channelId);
  expect(preview).toMatchObject({
    org_id: f.context.org_id,
    conversation_id: f.channelId,
    message_count: 3,
    file_count: 2,
    max_seq: 9,
    confirmation_name: "operations",
    last_successful_backup_at: null,
  });
  expect(Object.keys(preview).sort()).toEqual([
    "confirmation_name",
    "conversation_id",
    "expires_at",
    "file_count",
    "impact_digest",
    "last_successful_backup_at",
    "max_seq",
    "message_count",
    "org_id",
    "token",
  ]);
  expect(f.store.exportSnapshot()).toEqual(before);
  const request = {
    token: preview.token,
    confirmation_name: preview.confirmation_name,
    password: marker,
  };
  await refuses(
    f,
    () => f.as(f.actorId).purgeConversation(f.channelId, request),
    403,
    "comms_admin_required",
  );
  await refuses(
    f,
    () =>
      client.purgeConversation(f.channelId, {
        ...request,
        password: "ordinary text",
      }),
    403,
    "comms_fresh_admin_required",
  );
  await refuses(
    f,
    () =>
      client.purgeConversation(f.channelId, {
        ...request,
        confirmation_name: "not operations",
      }),
    422,
    "comms_invalid_input",
  );
  await refuses(
    f,
    () => client.purgeConversation(f.otherId, request),
    409,
    "comms_conflict",
  );
  // Reopened content changes are written by the real message/file families, not
  // a purge-specific test writer; re-archive before the destructive command.
  const g = make();
  const gRoom = await g.as().getConversation(g.channelId);
  const archived = await g
    .as()
    .archiveConversation(g.channelId, { if_match: gRoom.etag });
  const old = await g.as().previewPurge(g.channelId);
  await g.as().restoreConversation(g.channelId, { if_match: archived.etag });
  await g.as().sendMessage(g.channelId, send("New impact", 301));
  await upload(g);
  const reopened = await g.as().getConversation(g.channelId);
  await g.as().archiveConversation(g.channelId, { if_match: reopened.etag });
  await refuses(
    g,
    () =>
      g.as().purgeConversation(g.channelId, {
        token: old.token,
        confirmation_name: old.confirmation_name,
        password: marker,
      }),
    412,
    "comms_precondition_failed",
  );
  expect(await g.as().previewPurge(g.channelId)).toMatchObject({
    message_count: 4,
    file_count: 2,
    max_seq: 10,
  });
  f.store.failNextCommit();
  await refuses(
    f,
    () => client.purgeConversation(f.channelId, request),
    503,
    "comms_unavailable",
  );
  expect(
    (await client.downloadAttachment(f.channelId, ownedFile.id)).bytes.size,
  ).toBeGreaterThan(0);
  const result = await client.purgeConversation(f.channelId, request);
  expect(result).toMatchObject({
    org_id: f.context.org_id,
    conversation_id: f.channelId,
    purged_message_count: 3,
    purged_file_count: 2,
  });
  const after = f.store.exportSnapshot();
  expect(after.state.messages).toEqual({
    [f.otherMessageId]: before.state.messages[f.otherMessageId],
  });
  expect(after.state.threads).toEqual({});
  expect(after.state.revisions).toEqual({});
  expect(after.state.files[f.oldFileId]).toBeUndefined();
  expect(after.state.files[ownedFile.id]).toBeUndefined();
  expect(after.state.files[siblingFile.id]).toEqual(
    before.state.files[siblingFile.id],
  );
  expect(after.state.conversations[f.otherId]).toEqual(
    before.state.conversations[f.otherId],
  );
  expect(after.state.members[f.otherId]).toEqual(
    before.state.members[f.otherId],
  );
  expect(after.state.schedules[f.siblingScheduleId]).toEqual(
    before.state.schedules[f.siblingScheduleId],
  );
  expect(
    await (
      await client.downloadAttachment(f.otherId, siblingFile.id)
    ).bytes.arrayBuffer(),
  ).toEqual(await siblingDownload.bytes.arrayBuffer());
  await failure(client.getConversation(f.channelId), 404, "comms_not_found");
  await expect(
    client.downloadAttachment(f.channelId, ownedFile.id),
  ).rejects.toMatchObject({ kind: "http", failure: { status: 404 } });
  noPrivateMaterial(result);
  noPrivateMaterial(after);

  // A claimed job belongs to its resource, but cannot revive a purged source.
  const reached = deferred<void>();
  const release = deferred<void>();
  const h = make({
    beforeScheduleSend: async () => {
      reached.resolve();
      await release.promise;
    },
  });
  const scheduled = await h.as().createSchedule({
    ...send("Claimed before purge", 302),
    conversation_id: h.channelId,
    parent_id: null,
    also_send_to_channel: false,
    send_at: new Date(start + 60_000).toISOString(),
  });
  const dispatch = h
    .as()
    .sendScheduleNow(scheduled.data.id, { if_match: scheduled.etag });
  // Attach both handlers now; an early setup failure must not become unhandled.
  const settled = dispatch.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let purged: ReturnType<typeof h.store.exportSnapshot> | undefined;
  let deliveries: C.CommsEvent[] = [];
  try {
    await reached.promise;
    expect((await h.as().getSchedule(scheduled.data.id)).data.status).toBe(
      "running",
    );
    const sibling =
      h.store.exportSnapshot().state.schedules[h.siblingScheduleId];
    const current = await h.as().getConversation(h.channelId);
    await h.as().archiveConversation(h.channelId, { if_match: current.etag });
    const challenge = await h.as().previewPurge(h.channelId);
    await h.as().purgeConversation(h.channelId, {
      token: challenge.token,
      confirmation_name: challenge.confirmation_name,
      password: marker,
    });
    purged = h.store.exportSnapshot();
    for (const jobId of [h.pendingScheduleId, scheduled.data.id]) {
      expect(purged.state.schedules[jobId]).toMatchObject({
        status: "failed",
        failure_code: "access_lost",
        message_id: null,
      });
    }
    expect(purged.state.schedules[h.siblingScheduleId]).toEqual(sibling);
    expect(
      Object.values(purged.state.messages).some(
        (message) => message.conversation_id === h.channelId,
      ),
    ).toBe(false);
    expect(purged.state.high_water_seq[h.channelId]).toBeUndefined();
    expect(purged.state.idempotency).toEqual({});
    deliveries = structuredClone(h.events);
  } finally {
    release.resolve();
    await settled;
  }
  expect(await settled).toMatchObject({
    value: { status: "failed", failure_code: "access_lost", message_id: null },
  });
  expect(h.store.exportSnapshot()).toEqual(purged);
  expect(h.events).toEqual(deliveries);
});

test("one preview admits one in-flight apply and failed commit releases rather than consumes it", async ({
  make,
}) => {
  let hold = false;
  const entered = deferred<void>();
  const answer = deferred<unknown>();
  const f = make({
    verifyConfirmation: () => {
      if (hold) {
        entered.resolve();
        return answer.promise;
      }
      return Promise.resolve(true);
    },
  });
  const client = f.as();
  const current = await client.getRetention(workspace);
  const policy = { scope: workspace, message_days: 30, file_days: 0 };
  const preview = await client.previewRetention(policy, {
    if_match: current.etag,
    password: marker,
  });
  const request = { ...policy, preview_digest: preview.preview_digest };
  const options = { if_match: current.etag, password: marker };
  hold = true;
  f.store.failNextCommit();
  const first = client.updateRetention(request, options);
  const failed = failure(first, 503, "comms_unavailable");
  await entered.promise;
  await refuses(
    f,
    () => client.updateRetention(request, options),
    409,
    "comms_conflict",
  );
  hold = false;
  answer.resolve(true);
  await failed;
  expect(
    (await client.getRetention(workspace)).data.effective.message_days,
  ).toBe(0);
  const accepted = await client.updateRetention(request, options);
  expect(accepted.data.effective.message_days).toBe(30);
  // Supply the NEW ETag: this must be consumed-preview refusal, not stale-tag proof.
  await refuses(
    f,
    () =>
      client.updateRetention(request, { ...options, if_match: accepted.etag }),
    409,
    "comms_conflict",
  );
});
