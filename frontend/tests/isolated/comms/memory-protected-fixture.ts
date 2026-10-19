/** PROMOTED / UNRUN — real family/resource composition; missing modules are SETUP. */
import { expect, test as base } from "@playwright/test";
import type * as C from "@/components/systems/comms/contract/types";
import type { MemoryCommsState } from "@/components/systems/comms/memory/model";
import { createMemoryStore } from "@/components/systems/comms/memory/store";
import {
  createMemoryAvailability,
  type MemoryClientBinding,
} from "@/components/systems/comms/memory/availability";
import { createConversationOperations } from "@/components/systems/comms/memory/conversation-operations";
import { createConfigurationOperations } from "@/components/systems/comms/memory/configuration-operations";
import { createMemoryFileResources } from "@/components/systems/comms/memory/files";
import { createMessageFamily } from "@/components/systems/comms/memory/messages";
import { createOperationalResources } from "@/components/systems/comms/memory/operational-resources";
import { createOperationalFamily } from "@/components/systems/comms/memory/operations";
import {
  createProtectedToolOperations,
  createProtectedToolResources,
} from "@/components/systems/comms/memory/protected-tools";
import { seedFixture, owner, workspace } from "./memory-family-fixture";
import { png, deferred } from "./memory-message-fixture";

export { expect, workspace, png, deferred };
export const marker = "CONFIRM LOCAL SAMPLE"; // Nonsecret ID19 example confirmation.
export const start = Date.parse("2026-10-19T08:00:00Z");
export const id = (n: number) =>
  `74000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const missing = id(999);

function setup() {
  const s = seedFixture();
  const root = Object.values(s.initial.messages).find(
    (m) => m.parent_id === null,
  )!;
  const reply = Object.values(s.initial.messages).find(
    (m) => m.parent_id !== null,
  )!;
  Object.assign(root, {
    created_at: "2026-09-01T08:00:00Z",
    body: "Old root",
    record_links: [],
  });
  Object.assign(reply, {
    seq: 4,
    created_at: "2026-09-02T08:00:00Z",
    body: "Old reply",
  });
  const recent = {
    ...structuredClone(root),
    id: id(20),
    client_key: id(21),
    seq: 9,
    created_at: "2026-10-15T08:00:00Z",
    body: "Recent root",
  };
  s.initial.messages[recent.id] = recent;
  const other = {
    ...structuredClone(s.channel),
    id: id(30),
    name: "Other room",
  };
  s.initial.conversations[other.id] = other;
  s.initial.members[other.id] = structuredClone(
    s.initial.members[s.channel.id],
  );
  const otherMessage = {
    ...structuredClone(recent),
    id: id(31),
    client_key: id(32),
    conversation_id: other.id,
    seq: 1,
    body: "Other room survives",
  };
  s.initial.messages[otherMessage.id] = otherMessage;
  s.initial.high_water_seq[s.channel.id] = 9;
  s.initial.high_water_seq[other.id] = 1;
  const file: C.CommsFile = {
    id: id(40),
    org_id: owner.org_id,
    conversation_id: s.channel.id,
    creator_id: s.admin.user_id,
    purpose: "comms_attachment",
    filename: "old.png",
    expected_size: 1,
    actual_size: 1,
    media_type: "image/png",
    state: "ready",
    failure_code: null,
    is_deleted: false,
    created_at: "2026-09-03T08:00:00Z",
    updated_at: "2026-09-03T08:00:00Z",
  };
  s.initial.files[file.id] = file; // Metadata only; never claimed downloadable.
  root.attachment_ids = [file.id];
  s.initial.revisions[root.id] = [
    {
      id: id(41),
      message_id: root.id,
      author_id: root.author_id,
      created_at: root.created_at,
      body: "Earlier old root",
    },
  ];
  s.initial.users[s.context.user_id].followed_thread_ids = Object.keys(
    s.initial.threads,
  );
  const siblingSchedule: C.Schedule = {
    id: id(51),
    org_id: owner.org_id,
    created_at: "2026-10-19T08:00:00Z",
    updated_at: "2026-10-19T08:00:00Z",
    author_id: s.context.user_id,
    status: "pending",
    message_id: null,
    failure_code: null,
    request: {
      conversation_id: other.id,
      client_key: id(50),
      body: "Keep scheduled sibling",
      attachment_ids: [],
      record_ids: [],
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
      reply_to_id: null,
      send_at: "2026-10-20T08:00:00Z",
      parent_id: null,
      also_send_to_channel: false,
    },
  };
  s.initial.schedules[siblingSchedule.id] = siblingSchedule;
  s.initial.schedules[id(52)] = {
    ...structuredClone(siblingSchedule),
    id: id(52),
    request: {
      ...structuredClone(siblingSchedule.request),
      conversation_id: s.channel.id,
      client_key: id(53),
      parent_id: root.id,
    },
  };
  return {
    ...s,
    rootId: root.id,
    replyId: reply.id,
    recentId: recent.id,
    otherId: other.id,
    otherMessageId: otherMessage.id,
    oldFileId: file.id,
    siblingScheduleId: siblingSchedule.id,
    pendingScheduleId: id(52),
  };
}
export type Setup = ReturnType<typeof setup>;
type Options = {
  prepare?: (s: Setup) => void;
  snapshot?: unknown;
  beforeScheduleSend?: (jobId: string, signal: AbortSignal) => Promise<void>;
} & Pick<
  Parameters<typeof createProtectedToolResources>[0],
  "verifyConfirmation"
>;
type ComposedFamily = ReturnType<typeof createConversationOperations> &
  ReturnType<typeof createConfigurationOperations> &
  ReturnType<typeof createMessageFamily> &
  ReturnType<typeof createOperationalFamily> &
  ReturnType<typeof createProtectedToolOperations>;

function fixture(options: Options = {}, incarnation = 1) {
  const s = setup();
  options.prepare?.(s);
  let time = start;
  let sequence = 1;
  const clock = () => time;
  const store = createMemoryStore({
    owner: s.context,
    initial: s.initial,
    snapshot: options.snapshot,
    clock,
    uuid: () =>
      `74100000-0000-4000-${(0x8000 + incarnation).toString(16)}-${(sequence++).toString(16).padStart(12, "0")}`,
  });
  const events: C.CommsEvent[] = [];
  const handles = new Map<string, ReturnType<typeof store.bind>>();
  const bindings = new Map<string, MemoryClientBinding>();
  const families = new Map<string, ComposedFamily>();
  const handle = (userId = s.admin.user_id) => {
    let h = handles.get(userId);
    if (!h) {
      h = store.bind({ ...s.context, user_id: userId });
      h.events.subscribe({
        on_event: (e) => {
          events.push(structuredClone(e));
        },
        on_connection: () => {},
        on_error: () => {},
      });
      handles.set(userId, h);
    }
    return h;
  };
  const createOwnerBinding = (): MemoryClientBinding => {
    // ID26: the seed/runtime owner is NOT this fixture's default admin helper.
    const ownerHandle = handle(s.context.user_id);
    const { authority } = createMemoryAvailability(ownerHandle.context);
    const ownerBinding = { handle: ownerHandle, authority };
    bindings.set(s.context.user_id, ownerBinding);
    return ownerBinding;
  };
  let files = createMemoryFileResources(store);
  let ops = createOperationalResources(store, {
    files,
    clock,
    ownerBinding: createOwnerBinding(),
    beforeScheduleSend: options.beforeScheduleSend,
  });
  let tools = createProtectedToolResources({
    store,
    files,
    clock,
    ...("verifyConfirmation" in options
      ? { verifyConfirmation: options.verifyConfirmation }
      : {}),
  });
  const as = (userId = s.admin.user_id) => {
    let family = families.get(userId);
    if (!family) {
      const h = handle(userId);
      const deps = ops.sendDependenciesFor(h);
      let binding = bindings.get(userId);
      if (!binding) {
        binding = { handle: h, authority: deps.authority };
        bindings.set(userId, binding);
      }
      family = {
        ...createConversationOperations(binding),
        ...createConfigurationOperations(binding),
        ...createMessageFamily(binding, deps),
        ...createOperationalFamily(binding, ops),
        ...createProtectedToolOperations(binding, tools),
      };
      families.set(userId, family);
    }
    return family;
  };
  let closed = false;
  return {
    ...s,
    store,
    events,
    handle,
    as,
    channelId: s.channel.id,
    adminId: s.admin.user_id,
    actorId: s.context.user_id,
    channelScope: { kind: "channel", id: s.channel.id } as const,
    otherScope: { kind: "channel", id: s.otherId } as const,
    setTime: (value: number) => {
      time = value;
    },
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    // One composition lifecycle; resource anchors own raw-reset retirement too.
    reset() {
      tools.dispose();
      ops.dispose();
      files.dispose();
      store.reset();
      families.clear();
      bindings.clear();
      handles.clear();
      files = createMemoryFileResources(store);
      ops = createOperationalResources(store, {
        files,
        clock,
        ownerBinding: createOwnerBinding(),
        beforeScheduleSend: options.beforeScheduleSend,
      });
      tools = createProtectedToolResources({
        store,
        files,
        clock,
        ...("verifyConfirmation" in options
          ? { verifyConfirmation: options.verifyConfirmation }
          : {}),
      });
    },
    close() {
      if (!closed) {
        closed = true;
        tools.dispose();
        ops.dispose();
        files.dispose();
        store.dispose();
        families.clear();
        bindings.clear();
        handles.clear();
      }
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;
export type Family = ReturnType<Fixture["as"]>;
export const test = base.extend<{ make: (options?: Options) => Fixture }>({
  make: async ({}, provide) => {
    const all: Fixture[] = [];
    try {
      await provide((options) => {
        const f = fixture(options, all.length + 1);
        all.push(f);
        return f;
      });
    } finally {
      for (const f of all) f.close();
    }
  },
});

export async function failure(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  await expect(promise).rejects.toMatchObject({
    kind: "http",
    failure: { status, body: { detail: { code } } },
  });
}
export async function refuses(
  f: Fixture,
  action: () => Promise<unknown>,
  status: number,
  code: string,
) {
  const state = f.store.exportSnapshot();
  const events = structuredClone(f.events);
  await failure(action(), status, code);
  expect(f.store.exportSnapshot()).toEqual(state);
  expect(f.events).toEqual(events);
}
export async function putRetention(f: Fixture, policy: C.RetentionPolicy) {
  const client = f.as();
  const current = await client.getRetention(policy.scope);
  const preview = await client.previewRetention(policy, {
    if_match: current.etag,
    password: marker,
  });
  return client.updateRetention(
    { ...policy, preview_digest: preview.preview_digest },
    { if_match: current.etag, password: marker },
  );
}
export function send(body: string, key: number): C.SendMessageRequest {
  return {
    body,
    client_key: id(key),
    attachment_ids: [],
    record_ids: [],
    mention_user_ids: [],
    mentions_channel: false,
    mentions_here: false,
    reply_to_id: null,
  };
}
export async function upload(f: Fixture, conversationId = f.channelId) {
  const bytes = png();
  const reserved = await f.as().reserveAttachment(conversationId, {
    filename: "pixel.png",
    expected_size: bytes.size,
  });
  return f.as().uploadAttachment(conversationId, reserved.id, bytes);
}
/** No role-management Comms method exists: synthetic external authority change,
 * through the real atomic store, never a method under test or fake client writer.
 */
export async function changeAuthority(
  f: Fixture,
  change: (state: MemoryCommsState) => void,
) {
  await f.handle().command({
    authorize() {},
    apply(draft) {
      change(draft);
      return {
        kind: "commit",
        value: undefined,
        version_keys: ["authority"],
        publications: [],
      };
    },
  });
}
export async function patchSettings(
  f: Fixture,
  scope: C.SettingsScope,
  patch: C.SettingsPatch,
) {
  const before = await f.as().getSettings(scope);
  return f.as().updateSettings(scope, patch, { if_match: before.etag });
}
export async function historyEntry(f: Fixture, scope: C.SettingsScope) {
  const entries = await f.as().listConfigurationHistory(scope);
  expect(entries.items).toHaveLength(1);
  return entries.items[0];
}
export function noPrivateMaterial(value: unknown) {
  // Serialized outputs/state, NEVER source text. Strict snapshot admission is the
  // store owner's proof; this detects a family leaking its invocation material.
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toMatch(
    /"(?:password|proof|verified_at|preview_digest|token)"\s*:/,
  );
}
