import { expect, test } from "@playwright/test";
import {
  createSampleCommands,
  createSampleResource,
} from "../../../src/components/sample/sample-async-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("commands guard duplicate submission immediately and release pending on rejection", async () => {
  const commands = createSampleCommands();
  const first = deferred<number>();
  let calls = 0;
  const pending = commands.run("save:record", () => {
    calls++;
    return first.promise;
  });
  expect(commands.isPending("save:record")).toBe(true);
  await expect(
    commands.run("save:record", async () => {
      calls++;
      return 2;
    }),
  ).rejects.toMatchObject({ kind: "conflict" });
  first.reject(new Error("Save rejected"));
  await expect(pending).rejects.toThrow("Save rejected");
  expect(commands.isPending()).toBe(false);
  expect(calls).toBe(1);
  expect(await commands.run("save:record", async () => 3)).toBe(3);
});

test("disposing commands aborts their signals without canceling an already accepted result", async () => {
  const commands = createSampleCommands();
  const first = deferred<number>();
  let signal: AbortSignal | undefined;
  const pending = commands.run("send", (value) => {
    signal = value;
    return first.promise;
  });
  commands.cancel();
  expect(signal?.aborted).toBe(true);
  first.resolve(1);
  expect(await pending).toBe(1);
  expect(commands.isPending()).toBe(false);
});

test("resources ignore obsolete reads even when the loader ignores abort", async () => {
  const resource = createSampleResource<string>();
  const older = deferred<string>();
  const first = resource.load(() => older.promise, false);
  const latest = resource.load(async () => "latest", false);
  await latest;
  older.resolve("older");
  await first;
  expect(resource.getSnapshot()).toEqual({
    status: "ready",
    data: "latest",
    refreshing: false,
    error: null,
  });
});

test("refresh failure retains last good data and initial failure can retry", async () => {
  const resource = createSampleResource<number>();
  await resource.load(async () => {
    throw new Error("offline");
  }, false);
  expect(resource.getSnapshot()).toMatchObject({
    status: "error",
    data: undefined,
  });
  await resource.load(async () => 1, false);
  const refresh = deferred<number>();
  const pending = resource.load(() => refresh.promise, true);
  expect(resource.getSnapshot()).toMatchObject({
    status: "ready",
    data: 1,
    refreshing: true,
  });
  refresh.reject(new Error("offline"));
  await pending;
  expect(resource.getSnapshot()).toMatchObject({
    status: "ready",
    data: 1,
    refreshing: false,
  });
  expect(resource.getSnapshot().error).toBeTruthy();
  await resource.load(async () => 2, true);
  expect(resource.getSnapshot()).toEqual({
    status: "ready",
    data: 2,
    refreshing: false,
    error: null,
  });
  const changedQuery = deferred<number>();
  const changed = resource.load(() => changedQuery.promise, false);
  expect(resource.getSnapshot()).toMatchObject({
    status: "loading",
    data: undefined,
  });
  resource.cancel();
  changedQuery.resolve(3);
  await changed;
  expect(resource.getSnapshot().data).toBeUndefined();
});
