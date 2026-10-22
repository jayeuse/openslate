import { expect, test } from "@playwright/test";
import {
  attentionPolicy,
  minuteIn,
  unreadTotal,
} from "@/components/systems/comms/domain/attention";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import type {
  Bootstrap,
  ConversationSummary,
} from "@/components/systems/comms/contract/types";

const shared = {
  quiet_hours_start: "",
  quiet_hours_end: "",
  notification_sound: true,
  notification_badges: true,
  notification_preview: true,
  desktop_notifications: true,
};
const now = Date.parse("2026-10-21T12:00:00Z");

test("unread total skips hidden rows and counts only mentions where a conversation or category is muted", async () => {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: "00000000-0000-4000-8000-000000000102",
  };
  const runtime = createMemoryCommsRuntime({
    owner,
    initial: createMemorySeed(owner, { role: "admin", display_name: "Owner" }),
  });
  const initial = await runtime.client.bootstrap();
  runtime.dispose();
  const [room] = initial.conversations;
  const row = (
    id: string,
    unread: number,
    mentions: number,
    preferences: Partial<ConversationSummary["preferences"]>,
  ): ConversationSummary => ({
    ...room,
    conversation: { ...room.conversation, id },
    preferences: { ...room.preferences, ...preferences },
    unread_count: unread,
    mention_count: mentions,
  });
  const data: Bootstrap = {
    ...initial,
    conversations: [
      row("94000000-0000-4000-8000-000000000001", 4, 0, {}),
      row("94000000-0000-4000-8000-000000000002", 9, 1, { notify: "mute" }),
      row("94000000-0000-4000-8000-000000000003", 6, 2, {
        mute: { kind: "until", until: "2026-10-21T13:00:00Z" },
      }),
      row("94000000-0000-4000-8000-000000000004", 5, 0, {
        mute: { kind: "until", until: "2026-10-21T11:00:00Z" },
      }),
      row("94000000-0000-4000-8000-000000000005", 8, 8, { hidden: true }),
    ],
  };
  expect(unreadTotal(data, now)).toBe(12);
  const categoryMuted: Bootstrap = {
    ...data,
    categories: data.categories.map((item) => ({
      ...item,
      preferences: { ...item.preferences, mute: { kind: "indefinite" } },
    })),
  };
  expect(unreadTotal(categoryMuted, now)).toBe(3);
});

test("regional minutes follow the person's time zone and refuse an unknown zone", () => {
  expect(minuteIn("Asia/Manila", Date.parse("2026-10-21T14:30:00Z"))).toBe(
    1350,
  );
  expect(minuteIn("Not/A_Zone", now)).toBeNull();
});

test("quiet hours, preferences and the shared policy decide each alert channel", () => {
  const night = { quiet_hours_start: "22:00", quiet_hours_end: "07:00" };
  const cases = [
    ["no quiet hours", shared, {}, 600, [true, true, true, true]],
    [
      "inside quiet hours across midnight",
      shared,
      night,
      1380,
      [false, false, true, true],
    ],
    ["after quiet hours end", shared, night, 450, [true, true, true, true]],
    [
      "unknown clock with quiet hours",
      shared,
      night,
      null,
      [false, false, true, true],
    ],
    [
      "unknown clock without quiet hours",
      shared,
      {},
      null,
      [true, true, true, true],
    ],
    [
      "personal cannot widen shared",
      { ...shared, desktop_notifications: false, notification_badges: false },
      { desktop_notifications: true, notification_badges: true },
      600,
      [false, true, true, false],
    ],
    [
      "personal opt-outs",
      shared,
      { notification_sound: false, notification_preview: false },
      600,
      [true, false, false, true],
    ],
  ] as const;
  for (const [, policy, personal, minute, expected] of cases) {
    const result = attentionPolicy(policy, personal, minute);
    expect([
      result.desktop,
      result.sound,
      result.preview,
      result.badges,
    ]).toEqual(expected);
  }
});
