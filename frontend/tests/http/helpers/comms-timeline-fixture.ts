import type { Page } from "@playwright/test";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { validateMemoryState } from "../../support/comms-memory/memory/snapshot";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import type { MemorySnapshot } from "../../support/comms-memory/memory/store-types";
import { serializeSampleSessionSnapshot } from "../../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../../src/components/systems/shared/runtime/workspace-identity";
import { defaultOrganization, signedInAs } from "./test";
import { installCommsLiveApi } from "./comms-live-api";

const liveFixtures = new WeakMap<
  Page,
  ReturnType<typeof createMemoryCommsRuntime>
>();
const liveServers = new WeakMap<
  Page,
  Awaited<ReturnType<typeof installCommsLiveApi>>
>();
export function timelineServer(page: Page) {
  const server = liveServers.get(page);
  if (!server) throw new Error("Timeline HTTP fixture is not installed");
  return server;
}
export function readTimelineSnapshot(page: Page) {
  const runtime = liveFixtures.get(page);
  if (!runtime) throw new Error("Timeline HTTP fixture is not installed");
  return runtime.exportSnapshot();
}

export const timelineId = (n: number) =>
  `78000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export async function seedTimeline(
  page: Page,
  count = 5000,
  lastRead = count,
  decorated = false,
  arrival = false,
  sparse = false,
  options: { pinnedRecord?: boolean } = {},
) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  await signedInAs(page, { id: owner.user_id, role: "admin" });
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "Timeline owner",
  });
  const room = Object.values(initial.conversations)[0];
  const template = Object.values(initial.messages).find(
    (message) => message.parent_id === null,
  )!;
  const authors = Object.values(initial.people).filter(
    (person) => person.role === "member",
  );
  initial.messages = {};
  initial.threads = {};
  for (let seq = 1; seq <= count; seq++) {
    initial.messages[timelineId(seq)] = {
      ...template,
      id: timelineId(seq),
      client_key: timelineId(seq + 10000),
      seq,
      author_id: authors[Math.floor(seq / 5) % authors.length].user_id,
      created_at: new Date(
        Date.parse("2026-01-01T00:00:00Z") + seq * 60000,
      ).toISOString(),
      body: `Timeline message ${seq}. ${"Coordination update for this owned conversation. ".repeat(4)}`,
      record_links: [],
    };
  }
  initial.high_water_seq[room.id] = count;
  if (sparse)
    for (let seq = lastRead + 1; seq < count - 49; seq++)
      delete initial.messages[timelineId(seq)];
  if (decorated) {
    const message = initial.messages[timelineId(count)];
    message.edited_at = "2026-01-02T00:00:00Z";
    message.reply_to_id = timelineId(1);
    message.record_links = template.record_links;
    message.reactions = [
      { emoji: "👍", user_ids: authors.map((person) => person.user_id) },
    ];
    initial.messages[timelineId(count - 1)].deleted_at = "2026-01-02T00:00:00Z";
  }
  initial.users[owner.user_id].last_read_seq[room.id] = lastRead;
  const pinnedRecordId = options.pinnedRecord
    ? Object.values(initial.records)[0].id
    : null;
  if (pinnedRecordId) {
    initial.configuration.workspace = {
      settings: { pinned_record_id: pinnedRecordId },
      capabilities: {
        scope: { kind: "workspace" },
        everyone: {},
        group_grants: [],
      },
    };
  }
  validateMemoryState(initial, owner.org_id);
  let snapshot: MemorySnapshot = { format: 1, owner, state: initial };
  if (arrival) {
    const runtime = createMemoryCommsRuntime({ owner, initial });
    try {
      await runtime.client.createSchedule({
        conversation_id: room.id,
        parent_id: null,
        also_send_to_channel: false,
        client_key: timelineId(99999),
        body: "A newly delivered scheduled message",
        attachment_ids: [],
        record_ids: [],
        mention_user_ids: [],
        mentions_channel: false,
        mentions_here: false,
        reply_to_id: null,
        send_at: new Date(Date.now() + 3600000).toISOString(),
      });
      snapshot = runtime.exportSnapshot();
    } finally {
      runtime.dispose();
    }
  }
  const key = workspaceSessionSnapshotStorageKey(owner.user_id, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    owner.user_id,
    { "comms-memory-v1": snapshot },
    owner.org_id,
  );
  await page.addInitScript(
    ({ key, value }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    { key, value },
  );
  const server = createMemoryCommsRuntime({ owner, initial, snapshot });
  liveFixtures.set(page, server);
  liveServers.set(
    page,
    await installCommsLiveApi(page, {
      userId: owner.user_id,
      organizationId: owner.org_id,
      runtime: server,
    }),
  );
  return {
    owner,
    conversationId: room.id,
    pinnedRecordId,
    newest: timelineId(count),
    newest50: Array.from({ length: Math.min(50, count) }, (_, index) =>
      timelineId(count - Math.min(50, count) + index + 1),
    ),
    serializedCharacters: value.length,
    storageKey: key,
  };
}
