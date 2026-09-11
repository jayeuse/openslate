import { expect, test } from "@playwright/test";
import {
  parseSettingsImport,
  selectedSettings,
  restoreConfigurationEntry,
} from "../../../src/components/sample/comms/tools-helpers";
test("settings import rejects entity payloads and invalid values rather than dropping them", () => {
  expect(() => parseSettingsImport('{"messages": []}')).toThrow();
  expect(() => parseSettingsImport('{"slowModeSeconds": -1}')).toThrow();
  expect(() => parseSettingsImport('{"dmRule":"none"}')).toThrow("workspace");
  expect(
    parseSettingsImport('{"mode":"thread-first","requireRecordLink":true}'),
  ).toEqual({ mode: "thread-first", requireRecordLink: true });
});
test("selected-field applications preserve unrelated settings and membership", () => {
  expect(
    selectedSettings(
      { mode: "announcements", defaultMemberIds: ["eli"], slowModeSeconds: 30 },
      ["mode"],
    ),
  ).toEqual({ mode: "announcements" });
});

import {
  createCommsConfiguration,
  type CommsHistoryEntry,
} from "../../../src/components/sample/comms/configuration";
test("restoring workspace history restores locks and logs the current configuration without replacing unrelated state", () => {
  const config = createCommsConfiguration();
  config.workspace.settings = { slowModeSeconds: 30 };
  config.lockedSettings = ["slowModeSeconds"];
  config.lockedPermissions = ["post"];
  config.channels.custom = {
    settings: { notificationMode: "none" },
    permissions: {},
  };
  config.schedules = [
    {
      id: "pending",
      channelId: "custom",
      text: "Keep draft",
      authorId: "sample-eli",
      sendAt: 900,
    },
  ];
  const entry: CommsHistoryEntry = {
    id: "change",
    created: 1,
    actorId: "sample-eli",
    label: "Workspace rules",
    scope: { kind: "workspace", id: "workspace" },
    before: { settings: { slowModeSeconds: 0 }, permissions: {} },
    after: config.workspace,
    beforeLocks: { settings: ["mode"], permissions: ["invite"] },
    afterLocks: { settings: ["slowModeSeconds"], permissions: ["post"] },
  };
  const result = restoreConfigurationEntry(config, entry);
  expect(result.workspace.settings.slowModeSeconds).toBe(0);
  expect(result.lockedSettings).toEqual(["mode"]);
  expect(result.lockedPermissions).toEqual(["invite"]);
  expect(result.channels).toEqual(config.channels);
  expect(result.schedules).toEqual(config.schedules);
  expect(config.workspace.settings.slowModeSeconds).toBe(30);
  expect(result.history[0].beforeLocks).toEqual({
    settings: ["slowModeSeconds"],
    permissions: ["post"],
  });
  expect(result.history[0].afterLocks).toEqual({
    settings: ["mode"],
    permissions: ["invite"],
  });
});

import { toolChannelMessages } from "../../../src/components/sample/comms/tools-helpers";
import { validateCommsMessage } from "../../../src/components/sample/comms/message-policy";
import {
  CHANNELS,
  MESSAGES,
  type Thread,
} from "../../../src/components/sample/comms/model";
import { initialPeople } from "../../../src/components/sample/access/model";
test("tool sending observes slow mode from recent thread replies in the destination channel", () => {
  const config = createCommsConfiguration();
  config.workspace.settings.slowModeSeconds = 60;
  const now = Date.UTC(2026, 8, 15);
  const threads: Thread[] = [
    {
      id: "recent-thread",
      messageId: MESSAGES[0].id,
      subscribed: true,
      resolved: false,
      replies: [
        {
          id: "recent-reply",
          conversation: "recent-thread",
          text: "Just replied",
          author: "You",
          authorId: "sample-eli",
          created: now - 1000,
          pinned: false,
        },
      ],
    },
  ];
  const failure = validateCommsMessage({
    config,
    person: initialPeople.find((p) => p.id === "sample-eli"),
    channel: CHANNELS[0],
    categories: [],
    people: initialPeople,
    messages: toolChannelMessages(MESSAGES, threads, CHANNELS[0].id),
    text: "Scheduled or automated message",
    files: [],
    kind: "post",
    now,
  });
  expect(failure).toContain("Slow mode");
  expect(toolChannelMessages(MESSAGES, threads, CHANNELS[1].id)).toEqual([]);
});
