/** PROMOTED / UNRUN — composed real families, not a complete CommsClient stub. */
import type * as C from "@/components/systems/comms/contract/types";
import { parseTemplateImport } from "@/components/systems/comms/domain/template-import";
import {
  test,
  expect,
  marker,
  missing,
  workspace,
  refuses,
  failure,
  send,
  patchSettings,
  historyEntry,
  changeAuthority,
  noPrivateMaterial,
} from "./memory-protected-fixture";

test("exports require current admin and private member direct and group sources require reason plus real confirmation", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  const ordinary = { conversation_ids: [f.channelId], format: "csv" as const };
  await refuses(
    f,
    () => f.as(f.actorId).startExport(ordinary),
    403,
    "comms_admin_required",
  );
  await refuses(
    f,
    () => client.startExport({ ...ordinary, conversation_ids: [missing] }),
    404,
    "comms_not_found",
  );
  const publicJob = await client.startExport(ordinary); // NO FreshAdminOptions.
  expect(publicJob).toMatchObject({
    requested_by: f.adminId,
    org_id: f.context.org_id,
    status: "succeeded",
    request: ordinary,
    failure_code: null,
  });
  const privateRoom = await client.createChannel({
    name: "Private records",
    topic: "Synthetic",
    position: 1,
    category_id: f.category.id,
    scope: "members",
    member_ids: [f.actorId, f.peer.user_id],
  });
  const direct = await client.findOrCreateDirect({ recipient_id: f.actorId });
  const group = await client.createGroup({
    name: "Private group",
    participant_ids: [f.adminId, f.actorId, f.peer.user_id],
  });
  for (const conversationId of [
    privateRoom.data.id,
    direct.data.id,
    group.data.id,
  ]) {
    const request = {
      ...ordinary,
      conversation_ids: [conversationId],
      reason: "Local sample investigation",
    };
    await refuses(
      f,
      () => client.startExport(request),
      403,
      "comms_fresh_admin_required",
    );
    await refuses(
      f,
      () => client.startExport(request, { password: "not the sample marker" }),
      403,
      "comms_fresh_admin_required",
    );
    await refuses(
      f,
      () =>
        client.startExport(
          { ...ordinary, conversation_ids: [conversationId] },
          { password: marker },
        ),
      422,
      "comms_invalid_input",
    );
    const job = await client.startExport(request, { password: marker });
    expect(job).toMatchObject({
      status: "succeeded",
      requested_by: f.adminId,
      request,
      failure_code: null,
    });
    noPrivateMaterial(job);
  }
  const jobs = await client.listExports();
  expect(jobs.items).toHaveLength(4);
  for (const job of jobs.items)
    expect(Object.keys(job).sort()).toEqual([
      "created_at",
      "failure_code",
      "id",
      "org_id",
      "request",
      "requested_by",
      "status",
      "updated_at",
    ]);
  noPrivateMaterial(f.store.exportSnapshot());
});

test("downloads return fixed sample CSV without another password and refuse lost sources or metadata-only reload", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  const privateRoom = await client.createChannel({
    name: "Export selection",
    topic: "Synthetic",
    position: 1,
    category_id: f.category.id,
    scope: "members",
    member_ids: [f.actorId],
  });
  await client.sendMessage(
    privateRoom.data.id,
    send("Selected private row", 201),
  );
  const request = {
    conversation_ids: [privateRoom.data.id],
    format: "csv" as const,
    after: "2026-10-18",
    before: "2026-10-20",
    reason: "Owned local sample",
  };
  const job = await client.startExport(request, { password: marker });
  f.advance(120_000);
  const download = await client.downloadExport(job.id); // RequestOptions only, no GET password.
  expect(download.bytes).toBeInstanceOf(Blob);
  expect(download.media_type).toBe("text/csv; charset=utf-8");
  expect(download.bytes.type).toBe(download.media_type);
  const text = await download.bytes.text();
  expect(text).toBe('"source","content"\r\n"OpenComms","Local sample export"');
  expect(download.filename).toBe("opencomms-sample.csv");
  expect(text).not.toContain("Old root");
  expect(text).not.toContain("Other room survives");
  // Phase A always downloads the same explicitly synthetic CSV, not selected content.
  const selected = await client.startExport({
    conversation_ids: [f.channelId],
    format: "csv",
    after: "2026-10-14",
    before: "2026-10-16",
  });
  const selectedText = await (
    await client.downloadExport(selected.id)
  ).bytes.text();
  expect(selectedText).toBe(
    '"source","content"\r\n"OpenComms","Local sample export"',
  );
  expect(selectedText).not.toContain("Old root");
  expect(selectedText).not.toContain("Old reply");
  const xlsxJob = await client.startExport(
    { ...request, format: "xlsx" },
    { password: marker },
  );
  const workbook = await client.downloadExport(xlsxJob.id);
  expect(workbook.media_type).toBe("text/csv; charset=utf-8");
  expect(workbook.filename).toBe("opencomms-sample.csv");
  expect(await workbook.bytes.text()).toBe(text);
  const snapshot = f.store.exportSnapshot();
  noPrivateMaterial(snapshot);
  const reloaded = make({ snapshot });
  expect(reloaded.store.restoration).toBe("restored");
  await failure(reloaded.as().downloadExport(job.id), 503, "comms_unavailable");
  // Admins read every live in-org source by policy: simulate SOURCE disappearance,
  // not a fictional private-membership removal that would revoke admin authority.
  const room = await client.getConversation(privateRoom.data.id);
  await client.archiveConversation(privateRoom.data.id, {
    if_match: room.etag,
  });
  const purge = await client.previewPurge(privateRoom.data.id);
  await client.purgeConversation(privateRoom.data.id, {
    token: purge.token,
    confirmation_name: purge.confirmation_name,
    password: marker,
  });
  await failure(client.downloadExport(job.id), 404, "comms_not_found");
  await changeAuthority(f, (state) => {
    state.people[f.adminId].role = "member";
  });
  await failure(
    client.downloadExport(selected.id),
    403,
    "comms_admin_required",
  );
});

test("fixed sample exports do not encode message input and restored private metadata cannot replace captured reason provenance", async ({
  make,
}) => {
  const f = make({
    prepare(s) {
      s.initial.messages[s.recentId].body = "Unpaired \ud800";
    },
  });
  const job = await f
    .as()
    .startExport({ conversation_ids: [f.channelId], format: "xlsx" });
  expect(job).toMatchObject({ status: "succeeded", failure_code: null });
  expect(await f.as().getExport(job.id)).toEqual(job);
  expect(await (await f.as().downloadExport(job.id)).bytes.text()).toBe(
    '"source","content"\r\n"OpenComms","Local sample export"',
  );
  expect((await f.as().listExports()).items).toEqual([job]);
  // A schema-valid persisted job is not proof that this lifetime ever admitted
  // its private source/reason or produced its bytes. No forged sidecar fixture.
  const g = make();
  const room = await g.as().findOrCreateDirect({ recipient_id: g.actorId });
  const accepted = await g.as().startExport(
    {
      conversation_ids: [room.data.id],
      format: "csv",
      reason: "Local sample",
    },
    { password: marker },
  );
  const copied = g.store.exportSnapshot();
  delete copied.state.exports[accepted.id].request.reason;
  const loaded = make({ snapshot: copied });
  // Store schema permits reason optional; protected download must fail closed.
  expect(loaded.store.restoration).toBe("restored");
  await expect(loaded.as().downloadExport(accepted.id)).rejects.toMatchObject({
    kind: "http",
    failure: { status: 503, body: { detail: { code: "comms_unavailable" } } },
  });
  noPrivateMaterial(copied);
});

test("template raw import and create save admission reject invalid mixed input without changing the saved template", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  const raw =
    '{"name":"Dispatch","description":"Owned","settings":{"formatting":false}}';
  const input = parseTemplateImport(raw);
  expect(input).toEqual({
    name: "Dispatch",
    description: "Owned",
    settings: { formatting: false },
  });
  for (const text of [
    " ".repeat(65_536) + raw, // Raw byte cap before JSON; canonical object is tiny.
    '{"name":"x","description":"","settings":{"quiet_hours_start":"22:00"}}',
    '{"name":"x","description":"","settings":{"retention_days":7}}',
    '{"name":"x","description":"","settings":{},"messages":[]}',
  ])
    expect(() => parseTemplateImport(text)).toThrow();
  await refuses(
    f,
    () => f.as(f.actorId).createTemplate(input),
    403,
    "comms_admin_required",
  );
  const template = await client.createTemplate(input);
  const bad: C.TemplateImport & { retention_days: number } = {
    ...input,
    settings: { formatting: true },
    retention_days: 7,
  };
  await refuses(
    f,
    () =>
      client.saveTemplate(template.data.id, bad, { if_match: template.etag }),
    422,
    "comms_invalid_input",
  );
  await refuses(
    f,
    () =>
      client.createTemplate({
        ...input,
        settings: { formatting: true, default_member_ids: [missing] },
      }),
    422,
    "comms_invalid_input",
  );
  const saved = await client.saveTemplate(
    template.data.id,
    { ...input, description: "Revised" },
    { if_match: template.etag },
  );
  expect((await client.getTemplate(saved.data.id)).data).toMatchObject({
    name: "Dispatch",
    description: "Revised",
    settings: { formatting: false },
  });
  expect((await client.listTemplates()).items).toHaveLength(1);
  await refuses(
    f,
    () =>
      client.saveTemplate(saved.data.id, input, { if_match: template.etag }),
    412,
    "comms_precondition_failed",
  );
});

test("template mixed multi-target apply is atomic skips locks and binds target ancestry template and capability state", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  const ws = await patchSettings(f, workspace, { formatting: false });
  await client.setSettingsLocks(
    { keys: ["formatting"] },
    { if_match: ws.etag },
  );
  const caps = await client.getCapabilityConfiguration(workspace);
  await client.setCapabilityConfiguration(
    {
      ...caps.data,
      group_grants: [{ group_id: f.group.id, capability: "pin" }],
    },
    { if_match: caps.etag },
  );
  const locks = await client.getCapabilityLocks();
  await client.setCapabilityLocks(
    { capabilities: ["react"] },
    { if_match: locks.etag },
  );
  await patchSettings(f, f.channelScope, {
    keywords: ["before"],
    link_previews: true,
  });
  const localCaps = await client.getCapabilityConfiguration(f.channelScope);
  await client.setCapabilityConfiguration(
    {
      ...localCaps.data,
      group_grants: [
        { group_id: f.group.id, capability: "mentionChannel" },
        { group_id: f.group.id, capability: "pin" },
      ],
    },
    { if_match: localCaps.etag },
  );
  const template = await client.createTemplate({
    name: "Mixed",
    description: "",
    settings: { formatting: true, keywords: ["dispatch"] },
    capabilities: { everyone: { react: false }, group_grants: [] },
  });
  const request = {
    conversation_ids: [f.channelId, f.otherId],
    keys: ["formatting", "keywords"] as C.SettingKey[],
    capability_keys: ["react", "pin"] as const,
  };
  // Use mutable wire arrays, not readonly tuple casts at runtime boundaries.
  const applyRequest: C.TemplateApplyRequest = {
    ...request,
    capability_keys: ["react", "pin"],
  };
  const preview = await client.previewTemplateApply(
    template.data.id,
    applyRequest,
  );
  expect(preview.data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        conversation_id: f.channelId,
        after: expect.objectContaining({
          keywords: ["dispatch"],
          link_previews: true,
        }),
        skipped_locked_keys: ["formatting"],
        capabilities: expect.objectContaining({ skipped_locked: ["react"] }),
      }),
    ]),
  );
  await refuses(
    f,
    () =>
      f.as(f.actorId).applyTemplate(template.data.id, applyRequest, {
        if_match: preview.etag,
      }),
    403,
    "comms_admin_required",
  );
  await refuses(
    f,
    () =>
      client.previewTemplateApply(template.data.id, {
        ...applyRequest,
        conversation_ids: [f.channelId, missing],
      }),
    404,
    "comms_not_found",
  );
  // A valid first target must never commit before validation of the second target.
  await refuses(
    f,
    () =>
      client.applyTemplate(
        template.data.id,
        { ...applyRequest, conversation_ids: [f.channelId, missing] },
        { if_match: preview.etag },
      ),
    404,
    "comms_not_found",
  );
  await patchSettings(f, f.otherScope, { keywords: ["changed after preview"] });
  await refuses(
    f,
    () =>
      client.applyTemplate(template.data.id, applyRequest, {
        if_match: preview.etag,
      }),
    412,
    "comms_precondition_failed",
  );
  const moved = await client.previewTemplateApply(
    template.data.id,
    applyRequest,
  );
  const room = await client.getConversation(f.otherId);
  await client.updateChannel(
    f.otherId,
    { category_id: null },
    { if_match: room.etag },
  );
  await refuses(
    f,
    () =>
      client.applyTemplate(template.data.id, applyRequest, {
        if_match: moved.etag,
      }),
    412,
    "comms_precondition_failed",
  );
  const editedTemplate = await client.previewTemplateApply(
    template.data.id,
    applyRequest,
  );
  await client.saveTemplate(
    template.data.id,
    {
      name: "Mixed",
      description: "Changed",
      settings: { formatting: true, keywords: ["dispatch"] },
      capabilities: { everyone: { react: false }, group_grants: [] },
    },
    { if_match: template.etag },
  );
  await refuses(
    f,
    () =>
      client.applyTemplate(template.data.id, applyRequest, {
        if_match: editedTemplate.etag,
      }),
    412,
    "comms_precondition_failed",
  );
  const beforeLocks = await client.previewTemplateApply(
    template.data.id,
    applyRequest,
  );
  const currentLocks = await client.getCapabilityLocks();
  const moreLocks = await client.setCapabilityLocks(
    { capabilities: ["react", "pin"] },
    { if_match: currentLocks.etag },
  );
  await refuses(
    f,
    () =>
      client.applyTemplate(template.data.id, applyRequest, {
        if_match: beforeLocks.etag,
      }),
    412,
    "comms_precondition_failed",
  );
  await client.setCapabilityLocks(
    { capabilities: ["react"] },
    { if_match: moreLocks.etag },
  );
  const ready = await client.previewTemplateApply(
    template.data.id,
    applyRequest,
  );
  const before = f.store.exportSnapshot();
  const observations: string[][][] = [];
  const stop = f.store.subscribe(() => {
    const state = f.store.exportSnapshot().state;
    observations.push([
      state.configuration[`channel:${f.channelId}`]?.settings.keywords ?? [],
      state.configuration[`channel:${f.otherId}`]?.settings.keywords ?? [],
    ]);
  });
  const result = await client.applyTemplate(template.data.id, applyRequest, {
    if_match: ready.etag,
  });
  stop();
  expect(observations).toEqual([[["dispatch"], ["dispatch"]]]);
  expect(result.items).toHaveLength(2);
  for (const item of result.items)
    expect(item).toMatchObject({
      applied_keys: ["keywords"],
      skipped_locked_keys: ["formatting"],
      applied_capabilities: ["pin"],
      skipped_locked_capabilities: ["react"],
    });
  const settings = await client.getSettings(f.channelScope);
  expect(settings.data.effective).toMatchObject({
    formatting: false,
    keywords: ["dispatch"],
    link_previews: true,
  });
  expect(
    (await f.as(f.actorId).getCapabilities(f.channelId)).capabilities.pin
      .allowed,
  ).toBe(true); // Ancestor grant survives selected local removal.
  expect(
    (await client.getCapabilityConfiguration(f.channelScope)).data.group_grants,
  ).toEqual([{ group_id: f.group.id, capability: "mentionChannel" }]);
  const after = f.store.exportSnapshot();
  expect(
    Object.keys(after.state.history).length -
      Object.keys(before.state.history).length,
  ).toBe(2);
  expect(after.state.members).toEqual(before.state.members);
  expect(after.state.messages).toEqual(before.state.messages);
  expect(after.state.schedules).toEqual(before.state.schedules);
  // Omitted capabilities must not turn a settings-only template into grant reset.
  const ordinary = await client.createTemplate({
    name: "Ordinary",
    description: "",
    settings: { keywords: ["ordinary"] },
  });
  const ordinaryRequest = {
    conversation_ids: [f.channelId],
    keys: ["keywords"] as C.SettingKey[],
  };
  const ordinaryPreview = await client.previewTemplateApply(
    ordinary.data.id,
    ordinaryRequest,
  );
  await client.applyTemplate(ordinary.data.id, ordinaryRequest, {
    if_match: ordinaryPreview.etag,
  });
  expect(
    (await client.getCapabilityConfiguration(f.channelScope)).data.group_grants,
  ).toEqual([{ group_id: f.group.id, capability: "mentionChannel" }]);
  const capabilityOnly = await client.createTemplate({
    name: "Reply switch",
    description: "",
    settings: {},
    capabilities: { everyone: { reply: false }, group_grants: [] },
  });
  const capRequest: C.TemplateApplyRequest = {
    conversation_ids: [f.otherId],
    keys: [],
    capability_keys: ["reply"],
  };
  const capPreview = await client.previewTemplateApply(
    capabilityOnly.data.id,
    capRequest,
  );
  await client.applyTemplate(capabilityOnly.data.id, capRequest, {
    if_match: capPreview.etag,
  });
  expect(
    (await client.getSettings(f.otherScope)).data.overrides.keywords,
  ).toEqual(["dispatch"]);
  expect(
    (await f.as(f.actorId).getCapabilities(f.otherId)).capabilities.reply
      .allowed,
  ).toBe(false);
});

test("history reads are redacted and exact-scope restore previews refuse source changes rather than replacing another scope", async ({
  make,
}) => {
  const f = make();
  const client = f.as();
  await patchSettings(f, f.channelScope, { keywords: ["changed"] });
  const entry = await historyEntry(f, f.channelScope);
  expect(entry).toMatchObject({
    scope: f.channelScope,
    actor_id: f.adminId,
    before: { settings: {} },
    after: { settings: { keywords: ["changed"] } },
  });
  const list = await client.listConfigurationHistory(f.channelScope);
  expect(list.items).toEqual([entry]);
  expect(JSON.stringify(list)).not.toContain("Old root");
  noPrivateMaterial(list);
  await refuses(
    f,
    () => f.as(f.actorId).listConfigurationHistory(f.channelScope),
    403,
    "comms_admin_required",
  );
  await refuses(
    f,
    () => client.getConfigurationHistory(f.otherScope, entry.id),
    404,
    "comms_not_found",
  );
  const current = await client.getSettings(f.channelScope);
  await refuses(
    f,
    () =>
      client.previewConfigurationRestore(f.otherScope, entry.id, {
        if_match: current.etag,
        password: marker,
      }),
    404,
    "comms_not_found",
  );
  const preview = await client.previewConfigurationRestore(
    f.channelScope,
    entry.id,
    { if_match: current.etag, password: marker },
  );
  expect(preview.data).toMatchObject({
    history_id: entry.id,
    scope: f.channelScope,
    before: { settings: { keywords: ["changed"] } },
    after: { settings: {} },
  });
  const room = await client.getConversation(f.channelId);
  await client.updateChannel(
    f.channelId,
    { category_id: null },
    { if_match: room.etag },
  );
  const freshTag = (await client.getSettings(f.channelScope)).etag;
  await refuses(
    f,
    () =>
      client.restoreConfiguration(
        f.channelScope,
        { history_id: entry.id, preview_digest: preview.data.preview_digest },
        { if_match: freshTag, password: marker },
      ),
    412,
    "comms_precondition_failed",
  );
  const replacement = await client.previewConfigurationRestore(
    f.channelScope,
    entry.id,
    { if_match: freshTag, password: marker },
  );
  await refuses(
    f,
    () =>
      client.restoreConfiguration(
        f.channelScope,
        {
          history_id: missing,
          preview_digest: replacement.data.preview_digest,
        },
        { if_match: replacement.etag, password: marker },
      ),
    404,
    "comms_not_found",
  );
  const restored = await client.restoreConfiguration(
    f.channelScope,
    { history_id: entry.id, preview_digest: replacement.data.preview_digest },
    { if_match: replacement.etag, password: marker },
  );
  expect(restored.data.settings).toEqual({});
  expect((await client.getSettings(f.otherScope)).data.overrides).toEqual({});
  // Historical schema tolerance is NOT current write admission. A one-sided old
  // quiet window may be read, but the shared settings validator must refuse it.
  const tolerant = make({
    prepare(s) {
      s.initial.history[entry.id] = {
        ...structuredClone(entry),
        before: {
          ...structuredClone(entry.before),
          settings: { quiet_hours_start: "22:00" },
        },
      };
    },
  });
  expect(
    (
      await tolerant
        .as()
        .getConfigurationHistory(tolerant.channelScope, entry.id)
    ).before.settings,
  ).toEqual({ quiet_hours_start: "22:00" });
  const tolerantTag = (await tolerant.as().getSettings(tolerant.channelScope))
    .etag;
  await refuses(
    tolerant,
    () =>
      tolerant
        .as()
        .previewConfigurationRestore(tolerant.channelScope, entry.id, {
          if_match: tolerantTag,
          password: marker,
        }),
    422,
    "comms_invalid_input",
  );
});

test("workspace history restore shares the configuration transaction including locks policy and before-after history", async ({
  make,
}) => {
  const f = make({
    prepare(s) {
      s.initial.configuration.workspace = {
        settings: { formatting: false },
        capabilities: { scope: workspace, everyone: {}, group_grants: [] },
      };
      s.initial.setting_locks = ["formatting"];
      s.initial.capability_locks = ["react"];
      s.initial.dm_rule = "none";
    },
  });
  const client = f.as();
  await patchSettings(f, workspace, { formatting: true });
  const target = await historyEntry(f, workspace);
  const ws = await client.getSettings(workspace);
  await client.setSettingsLocks(
    { keys: ["link_previews"] },
    { if_match: ws.etag },
  );
  const locks = await client.getCapabilityLocks();
  await client.setCapabilityLocks(
    { capabilities: ["reply"] },
    { if_match: locks.etag },
  );
  const direct = await client.getDirectPolicy();
  await client.setDirectPolicy(
    { dm_rule: "everyone" },
    { if_match: direct.etag },
  );
  await patchSettings(f, f.otherScope, { keywords: ["unrelated"] });
  const current = await client.getSettings(workspace);
  const preview = await client.previewConfigurationRestore(
    workspace,
    target.id,
    { if_match: current.etag, password: marker },
  );
  const request = {
    history_id: target.id,
    preview_digest: preview.data.preview_digest,
  };
  const options = { if_match: preview.etag, password: marker };
  f.store.failNextCommit();
  await refuses(
    f,
    () => client.restoreConfiguration(workspace, request, options),
    503,
    "comms_unavailable",
  );
  const before = f.store.exportSnapshot();
  const observed: {
    formatting: boolean | undefined;
    history: number;
    rule: string;
  }[] = [];
  const stop = f.store.subscribe(() => {
    const state = f.store.exportSnapshot().state;
    observed.push({
      formatting: state.configuration.workspace?.settings.formatting,
      history: Object.keys(state.history).length,
      rule: state.dm_rule,
    });
  });
  const result = await client.restoreConfiguration(workspace, request, options);
  stop();
  expect(result.data).toEqual({
    settings: { formatting: false },
    capabilities: { scope: workspace, everyone: {}, group_grants: [] },
    setting_locks: ["formatting"],
    capability_locks: ["react"],
    dm_rule: "none",
  });
  expect(observed).toEqual([
    {
      formatting: false,
      history: Object.keys(before.state.history).length + 1,
      rule: "none",
    },
  ]);
  expect((await client.getSettings(workspace)).etag).toBe(result.etag);
  const after = f.store.exportSnapshot();
  const added = Object.values(after.state.history).filter(
    (h) => !before.state.history[h.id],
  );
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    actor_id: f.adminId,
    scope: workspace,
    before: {
      settings: { formatting: true },
      setting_locks: ["link_previews"],
      capability_locks: ["reply"],
      dm_rule: "everyone",
    },
    after: result.data,
  });
  expect(after.state.configuration[`channel:${f.otherId}`]).toEqual(
    before.state.configuration[`channel:${f.otherId}`],
  );
  expect(after.state.members).toEqual(before.state.members);
  expect(after.state.messages).toEqual(before.state.messages);
  expect(after.state.schedules).toEqual(before.state.schedules);
  noPrivateMaterial(after);
});
