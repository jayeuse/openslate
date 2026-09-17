import { expect, test } from "@playwright/test";
import {
  createSampleRuntime,
  SampleOperationError,
} from "../../../src/components/sample/sample-runtime";

const decode = <T>(_key: string, value: unknown, initial: T): T =>
  value === undefined ? initial : (value as T);

test("async commands read the latest state and commit all owners together", async () => {
  const runtime = createSampleRuntime(decode, { count: 0, label: "initial" });
  const seen: unknown[] = [];
  runtime.subscribe(() => seen.push(runtime.getSnapshot()));
  const first = runtime.execute((draft) => {
    const count = draft.read("count", 0) + 1;
    draft.update("count", 0, count);
    draft.update("label", "", `count ${count}`);
    return { ok: true, count };
  });
  runtime.commit((draft) => draft.update("count", 0, 10));
  expect(await first).toEqual({ ok: true, count: 11 });
  expect(runtime.getSnapshot()).toEqual({ count: 11, label: "count 11" });
  expect(seen).toEqual([
    { count: 10, label: "initial" },
    { count: 11, label: "count 11" },
  ]);
});

test("rejected or throwing commands do not commit staged changes", async () => {
  const runtime = createSampleRuntime(decode, { count: 1 });
  const failure = await runtime.execute<{ ok: false; error: string }>(
    (draft) => {
      draft.update("count", 0, 99);
      return draft.reject({ ok: false, error: "Conflict" });
    },
  );
  expect(failure).toEqual({ ok: false, error: "Conflict" });
  await expect(
    runtime.execute((draft) => {
      draft.update("count", 0, 50);
      throw new Error("Rejected");
    }),
  ).rejects.toThrow("Rejected");
  expect(runtime.getSnapshot()).toEqual({ count: 1 });
});

test("reset and abort prevent pending commands from restoring obsolete state", async () => {
  const runtime = createSampleRuntime(decode, { count: 1 });
  const pending = runtime.execute((draft) => draft.update("count", 0, 2));
  runtime.reset();
  await expect(pending).rejects.toBeInstanceOf(SampleOperationError);
  const controller = new AbortController();
  const aborted = runtime.execute((draft) => draft.update("count", 0, 3), {
    signal: controller.signal,
  });
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ kind: "aborted" });
  expect(runtime.getSnapshot()).toEqual({});
});

test("reads are async and key subscriptions ignore unrelated and rejected writes", async () => {
  const runtime = createSampleRuntime(decode, { count: 1, label: "one" });
  let notifications = 0;
  runtime.subscribeKeys(["count"], () => notifications++);
  runtime.commit((draft) => draft.update("label", "", "two"));
  runtime.commit((draft) => {
    draft.update("count", 0, 3);
    return draft.reject({ ok: false });
  });
  expect(notifications).toBe(0);
  runtime.commit((draft) => draft.update("count", 0, (count) => count + 1));
  expect(notifications).toBe(1);
  expect(await runtime.load((source) => source.read("count", 0))).toBe(2);
});

test("feature resets cancel only work that depends on the reset keys", async () => {
  const runtime = createSampleRuntime(decode, { design: 1, messages: 0 });
  const design = runtime.execute((draft) => draft.update("design", 0, 2), {
    keys: ["design"],
  });
  const message = runtime.execute(
    (draft) => draft.update("messages", 0, (count) => count + 1),
    { keys: ["messages"] },
  );
  runtime.resetKeys(["design"]);
  await expect(design).rejects.toMatchObject({ kind: "aborted" });
  await message;
  expect(runtime.getSnapshot()).toEqual({ messages: 1 });
});

test("ordinary domain result objects do not implicitly reject a transaction", () => {
  const runtime = createSampleRuntime(decode);
  const result = runtime.commit((draft) => {
    draft.update("status", "", "reviewed");
    return { ok: false, description: "A saved inspection result" };
  });
  expect(result.ok).toBe(false);
  expect(runtime.read("status", "")).toBe("reviewed");
});

test("a transaction cannot publish an asynchronous recipe", () => {
  const runtime = createSampleRuntime(decode, { count: 1 });
  expect(() =>
    runtime.commit(async (draft) => {
      draft.update("count", 0, 2);
    }),
  ).toThrow("synchronous");
  expect(runtime.getSnapshot()).toEqual({ count: 1 });
});

test("a rejected recipe cannot leak nested mutations through read or updater values", async () => {
  const original = { fields: { name: "Original" } };
  const runtime = createSampleRuntime(decode, { record: original });
  await runtime.execute<{ ok: false }>((draft) => {
    const record = draft.read("record", original);
    record.fields.name = "Unaccepted read mutation";
    return draft.reject({ ok: false });
  });
  expect(runtime.read("record", original).fields.name).toBe("Original");
  expect(() =>
    runtime.commit((draft) =>
      draft.update("record", original, (record) => {
        record.fields.name = "Unaccepted updater mutation";
        throw new Error("Rejected");
      }),
    ),
  ).toThrow("Rejected");
  expect(original.fields.name).toBe("Original");
  expect(runtime.read("record", original).fields.name).toBe("Original");
});
