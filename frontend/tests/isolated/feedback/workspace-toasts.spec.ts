import { expect, test } from "@playwright/test";
import { toast } from "../../../src/components/ui/toast";
import { createCommsMessageOperations } from "../../../src/components/systems/comms/state/use-comms-message-operations";
import { reportCommsError } from "../../../src/components/systems/comms/state/comms-feedback";
import {
  initialPeople,
  initialRoles,
} from "../../../src/components/systems/shared/data/sample-people";
import { INITIAL_RECORDS } from "../../../src/components/systems/shared/data/sample-data";
import {
  CATEGORIES,
  CHANNELS,
  MESSAGES,
} from "../../../src/components/systems/comms/domain/model";
import { normalizeCommsConfiguration } from "../../../src/components/systems/comms/domain/configuration";
import {
  createSampleRuntime,
  type SampleDecoder,
} from "../../../src/components/systems/shared/runtime/sample-runtime";
import { createSampleCommands } from "../../../src/components/systems/shared/runtime/sample-async-state";

test("a real pending Comms cancellation cannot admit its caught error during account cleanup", async () => {
  toast.resumeWorkspace();
  const decode: SampleDecoder = <T>(
    _key: string,
    value: unknown,
    fallback: T,
  ) => (value === undefined ? fallback : (value as T));
  const runtime = createSampleRuntime(decode);
  const commands = createSampleCommands();
  const admissions: (string | null)[] = [];
  const original = toast.add;
  toast.add = (options) => {
    const id = original(options);
    admissions.push(id);
    return id;
  };
  const operations = createCommsMessageOperations({
    run: (key, recipe, keys) =>
      commands.run(key, (signal) => runtime.execute(recipe, { signal, keys })),
    selected: CHANNELS[0].id,
    viewerId: initialPeople[0].id,
    replyingTo: null,
    setThreadId: () => {},
    setReplyingTo: () => {},
    setNotice: reportCommsError,
    announce: () => {},
    scrollToLatest: () => {},
    config: normalizeCommsConfiguration(null),
    viewer: initialPeople[0],
    channel: CHANNELS[0],
    categories: CATEGORIES,
    people: initialPeople,
    roles: initialRoles,
    allMessages: MESSAGES,
    channelThreads: [],
    records: INITIAL_RECORDS,
  });
  try {
    const pending = operations.deleteMessage(MESSAGES[0].id);
    expect(commands.isPending()).toBe(true);
    toast.clearWorkspace();
    runtime.reset();
    commands.cancel();
    const error = await pending;
    expect(error).toBe(
      "The workspace changed before this operation finished. Try again.",
    );
    expect(admissions).toEqual([null]);
    toast.resumeWorkspace();
    reportCommsError(error!);
    expect(admissions[1]).toEqual(expect.any(String));
  } finally {
    toast.add = original;
    toast.clearWorkspace();
  }
});

test("workspace cleanup releases dedup callbacks once and preserves public MFA admission", () => {
  toast.resumeWorkspace();
  let closed = 0;
  toast.add({
    title: "Private review failed.",
    type: "error",
    onClose: () => closed++,
  });
  toast.add({
    title: "Private action completed.",
    type: "success",
    onClose: () => closed++,
  });
  toast.clearWorkspace();
  toast.clearWorkspace();
  expect(closed).toBe(2);
  expect(
    toast.add({
      title: "Late private error",
      type: "error",
      onClose: () => closed++,
    }),
  ).toBeNull();
  expect(closed).toBe(3);
  expect(
    toast.addPublic({
      title: "Authenticator cleanup could not finish",
      type: "error",
    }),
  ).toEqual(expect.any(String));
});
