import { expect, test } from "@playwright/test";
import { initialPeople } from "../../../src/components/sample/access/model";
import {
  createCommsConfiguration,
  DEFAULT_COMMS_PREFERENCES,
} from "../../../src/components/sample/comms/configuration";
import { CHANNELS } from "../../../src/components/sample/comms/model";
import {
  resolveCommsNotification,
  previewCommsNotification,
  type CommsNotificationInput,
} from "../../../src/components/sample/comms/notification-policy";
function fixture(): CommsNotificationInput {
  return {
    config: createCommsConfiguration(),
    person: initialPeople[1],
    channel: CHANNELS[0],
    platformPreferences: { threads: true, records: true, digest: false },
    event: { kind: "thread", text: "Dispatch update", followedThread: true },
    now: new Date(2026, 8, 11, 23, 0).getTime(),
  };
}
test("Platform thread and record switches remain authoritative", () => {
  const input = fixture();
  input.platformPreferences.threads = false;
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.event.kind = "record";
  input.platformPreferences.records = false;
  expect(resolveCommsNotification(input).allowed).toBe(false);
});
test("personal keywords qualify mention-only events but cannot override workspace locks or mutes", () => {
  const input = fixture();
  input.event = { kind: "message", text: "Urgent dispatch" };
  input.config.preferences[input.person!.id] = {
    ...structuredClone(DEFAULT_COMMS_PREFERENCES),
    settings: { notificationMode: "mentions", keywords: ["urgent"] },
  };
  expect(resolveCommsNotification(input).allowed).toBe(true);
  input.config.workspace.settings.notificationMode = "none";
  input.config.lockedSettings = ["notificationMode"];
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.config.lockedSettings = [];
  input.config.preferences[input.person!.id].mutedUntil[input.channel!.id] =
    input.now! + 1000;
  expect(resolveCommsNotification(input).allowed).toBe(false);
});
test("overnight quiet hours and device settings suppress alerts and previews redact content", () => {
  const input = fixture();
  input.config.workspace.settings = {
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
  };
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.config.workspace.settings = {
    mobileNotifications: false,
    notificationPreview: false,
  };
  input.device = "mobile";
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.device = "desktop";
  expect(previewCommsNotification(input)).toMatchObject({
    allowed: true,
    title: "New OpenComms activity",
  });
});
test("followed-thread opt out and inactive identity suppress notifications", () => {
  const input = fixture();
  input.config.workspace.settings.notifyFollowedThreads = false;
  input.config.preferences[input.person!.id] = {
    ...structuredClone(DEFAULT_COMMS_PREFERENCES),
    settings: { notifyFollowedThreads: true },
  };
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.config.workspace.settings.notifyFollowedThreads = true;
  input.person = { ...input.person!, active: false };
  expect(resolveCommsNotification(input).allowed).toBe(false);
});
test("shared notification filters cannot be widened by personal mode or keywords", () => {
  const input = fixture();
  input.event = { kind: "message", text: "Urgent dispatch" };
  input.config.workspace.settings = { notificationMode: "none" };
  input.config.preferences[input.person!.id] = {
    ...structuredClone(DEFAULT_COMMS_PREFERENCES),
    settings: { notificationMode: "all", keywords: ["urgent"] },
  };
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.config.workspace.settings = {
    notificationMode: "mentions",
    keywords: ["incident"],
  };
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.event.text = "Incident update";
  expect(resolveCommsNotification(input).allowed).toBe(true);
  input.config.preferences[input.person!.id].settings.notificationMode =
    "mentions";
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.event.mentioned = true;
  expect(resolveCommsNotification(input).allowed).toBe(true);
});
test("personal device and presentation switches cannot reenable shared disabled controls", () => {
  const input = fixture();
  input.config.workspace.settings = {
    desktopNotifications: false,
    mobileNotifications: false,
    notificationSound: false,
    notificationBadges: false,
    notificationPreview: false,
  };
  input.config.preferences[input.person!.id] = {
    ...structuredClone(DEFAULT_COMMS_PREFERENCES),
    settings: {
      desktopNotifications: true,
      mobileNotifications: true,
      notificationSound: true,
      notificationBadges: true,
      notificationPreview: true,
    },
  };
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.device = "mobile";
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.config.workspace.settings.mobileNotifications = true;
  expect(previewCommsNotification(input)).toMatchObject({
    allowed: true,
    sound: false,
    badge: false,
    preview: false,
    title: "New OpenComms activity",
  });
});
test("shared and personal quiet hours both apply independently", () => {
  const input = fixture();
  input.config.workspace.settings = {
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
  };
  input.config.preferences[input.person!.id] = {
    ...structuredClone(DEFAULT_COMMS_PREFERENCES),
    settings: { quietHoursStart: "12:00", quietHoursEnd: "13:00" },
  };
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.now = new Date(2026, 8, 11, 12, 30).getTime();
  expect(resolveCommsNotification(input).allowed).toBe(false);
  input.now = new Date(2026, 8, 11, 14, 0).getTime();
  expect(resolveCommsNotification(input).allowed).toBe(true);
});
