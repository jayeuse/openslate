import { expect, test } from "@playwright/test";
import { toast } from "../../../src/components/ui/toast";
import { createCommsMessageOperations } from "../../../src/components/systems/comms/state/use-comms-message-operations";
import { reportCommsError } from "../../../src/components/systems/comms/state/comms-feedback";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { createSampleCommands } from "../../../src/components/systems/shared/runtime/sample-async-state";

test("a real pending Comms cancellation cannot admit its caught error during account cleanup", async () => {
  toast.resumeWorkspace();
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000001",
    org_id: "00000000-0000-4000-8000-000000000102",
  };
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "Toast owner",
  });
  const root = Object.values(initial.messages).find(
    (message) => message.parent_id === null,
  )!;
  const runtime = createMemoryCommsRuntime({ owner, initial });
  const commands = createSampleCommands();
  const committed: unknown[] = [];
  const stop = runtime.subscribe(() =>
    committed.push(runtime.exportSnapshot()),
  );
  const admissions: (string | null)[] = [];
  const original = toast.add;
  toast.add = (options) => {
    const id = original(options);
    admissions.push(id);
    return id;
  };
  const operations = createCommsMessageOperations({
    run: (key, action) =>
      commands.run(key, (signal) => action(runtime.client, signal)),
    selected: root.conversation_id,
    viewerId: owner.user_id,
    replyingTo: null,
    setReplyingTo: () => {},
    setNotice: reportCommsError,
    announce: () => {},
    scrollToLatest: () => {},
    allMessages: [],
  });
  try {
    const pending = operations.deleteMessage(root.id);
    expect(commands.isPending()).toBe(true);
    toast.clearWorkspace();
    commands.cancel();
    runtime.dispose();
    const error = await pending;
    expect(committed).toEqual([]);
    expect(error).toBe(
      "The workspace changed before this operation finished. Try again.",
    );
    expect(admissions).toEqual([null]);
    toast.resumeWorkspace();
    reportCommsError(error!);
    expect(admissions[1]).toEqual(expect.any(String));
  } finally {
    stop();
    runtime.dispose();
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
