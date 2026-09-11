import { test, expect } from "@playwright/test";
import { createCommsConfiguration } from "../../../src/components/sample/comms/configuration";
import {
  validateCommsMessage,
  validateCommsMessageChange,
  type CommsMessageInput,
} from "../../../src/components/sample/comms/message-policy";
import {
  CHANNELS,
  CATEGORIES,
} from "../../../src/components/sample/comms/model";
import { initialPeople } from "../../../src/components/sample/access/model";
const input = (): CommsMessageInput => ({
  config: createCommsConfiguration(),
  person: initialPeople[1],
  channel: CHANNELS[0],
  categories: CATEGORIES,
  messages: [],
  text: "Hello",
  files: [],
  kind: "post",
  now: 1000000,
});
test("owner obeys archive, locked and required record policies", () => {
  const i = input();
  expect(validateCommsMessage(i)).toBeNull();
  i.channel = { ...i.channel!, archived: true };
  expect(validateCommsMessage(i)).toContain("archived");
  i.channel.archived = false;
  i.config.workspace.settings.locked = true;
  expect(validateCommsMessage(i)).toContain("locked");
  i.config.workspace.settings.locked = false;
  i.config.workspace.settings.requireRecordLink = true;
  expect(validateCommsMessage(i)).toContain("record");
});
test("slow mode and file limits apply to threaded messages", () => {
  const i = input();
  i.kind = "thread";
  i.config.workspace.settings.slowModeSeconds = 30;
  i.messages = [
    {
      id: "m",
      conversation: i.channel!.id,
      author: "You",
      text: "Previous",
      created: 999000,
      pinned: false,
    },
  ];
  expect(validateCommsMessage(i)).toContain("Slow mode");
  i.messages = [];
  i.config.workspace.settings.allowedFileTypes = [".pdf"];
  i.files = [{ id: "f", name: "photo.png", type: "image/png", size: 100 }];
  expect(validateCommsMessage(i)).toContain("file type");
});
test("announcement posting restricts members but replies remain allowed; system message setting gates apply", () => {
  const i = input();
  i.person = { ...initialPeople[1], id: "other" };
  i.config.workspace.settings.mode = "announcements";
  expect(validateCommsMessage(i)).toContain("managers");
  i.kind = "reply";
  expect(validateCommsMessage(i)).toBeNull();
  i.system = true;
  i.config.workspace.settings.systemMessages = false;
  expect(validateCommsMessage(i)).toContain("System messages");
});
test("edit ownership and windows cannot be bypassed by owner access", () => {
  const i = input();
  const message = {
    id: "m",
    conversation: i.channel!.id,
    author: "You",
    text: "Old",
    created: 0,
    pinned: false,
  };
  expect(validateCommsMessageChange({ ...i, message, kind: "edit" })).toContain(
    "window",
  );
  expect(
    validateCommsMessageChange({
      ...i,
      message: { ...message, created: i.now!, authorId: "someone" },
      kind: "edit",
    }),
  ).toContain("own");
});

test("workspace channel mode does not force direct messages into threads or announcements", () => {
  const i = input();
  i.channel = undefined;
  i.person = { ...initialPeople[1], id: "other" };
  i.config.workspace.settings.mode = "thread-first";
  expect(validateCommsMessage(i)).toBeNull();
  i.config.workspace.settings.mode = "announcements";
  expect(validateCommsMessage(i)).toBeNull();
});
