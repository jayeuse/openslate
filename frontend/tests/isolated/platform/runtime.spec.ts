import { expect, test } from "@playwright/test";
import { readPlatformSnapshot } from "../../../src/components/systems/platform/adapters/runtime";

test("Platform resource snapshot reads cross-feature owners through one loader", () => {
  const records = [
    {
      id: "record-current",
      title: "Current record",
      customer: "Customer",
      status: "Open",
      assignee: "Unassigned",
      dueDate: "",
    },
  ];
  const calls: string[] = [];
  const values: Record<string, unknown> = {
    records,
    platformNotificationPreferences: {
      threads: false,
      records: true,
      digest: true,
    },
  };
  const snapshot = readPlatformSnapshot(<T>(key: string, initial: T) => {
    calls.push(key);
    return (Object.hasOwn(values, key) ? values[key] : initial) as T;
  });

  expect(snapshot.records).toEqual(records);
  expect(snapshot.preferences.threads).toBe(false);
  expect(calls).toEqual(
    expect.arrayContaining([
      "access-people",
      "records",
      "commsMessages",
      "comms-configuration",
      "platformNotifications",
      "platformNotificationPreferences",
      "platformAccount",
    ]),
  );
});
