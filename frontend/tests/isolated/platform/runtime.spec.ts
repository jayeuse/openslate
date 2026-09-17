import { expect, test } from "@playwright/test";
import {
  completePlatformExport,
  normalizePlatformImportRows,
  pagePlatformSearch,
  readPlatformSnapshot,
} from "../../../src/components/sample/platform/runtime";
import { initialDesign } from "../../../src/components/sample/sandbox/model";

test("Platform search filters and sorts the complete match set before applying its visible limit", () => {
  const items = [
    { id: "3", title: "Repair valve" },
    { id: "1", title: "Repair pump" },
    { id: "2", title: "Repair seal" },
    { id: "4", title: "Replace motor" },
  ];

  const result = pagePlatformSearch(items, "repair", "platform-search:test", 2);

  expect(result.complete.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
  expect(result.page.items.map((item) => item.id)).toEqual(["1", "2"]);
  expect(result.page.total).toBe(3);
  expect(result.page.offset).toBe(0);
});

test("Platform export remains a complete collection and import defaults are explicit", () => {
  const records = Array.from({ length: 11 }, (_, index) => ({
    id: `record-${index}`,
    title: `Record ${index}`,
    customer: "Customer",
    status: "Open",
    assignee: "Unassigned",
    dueDate: "",
  }));

  expect(completePlatformExport(records)).toEqual({
    kind: "complete",
    queryKey: "platform:records:export",
    items: records,
  });
  expect(
    normalizePlatformImportRows([
      { title: " New job ", customer: " Client ", assignee: "", dueDate: "" },
      {
        title: "",
        customer: "Ignored",
        assignee: "Alex Lee",
        dueDate: "2026-10-01",
      },
    ]),
  ).toEqual([
    {
      title: "New job",
      customer: "Client",
      assignee: "Unassigned",
      dueDate: "",
    },
  ]);
});

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
    platformFollowedRecords: ["record-current"],
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
  expect(snapshot.followed).toEqual(["record-current"]);
  expect(snapshot.preferences.threads).toBe(false);
  expect(calls).toEqual(
    expect.arrayContaining([
      "access-people",
      "sandbox.design",
      "records",
      "commsMessages",
      "comms-configuration",
      "platformNotifications",
      "platformNotificationPreferences",
      "platformFollowedRecords",
      "commsRecordThreads",
      "platformAccount",
      "platformSessions",
    ]),
  );
});

test("Platform projects the current normalized Sandbox design for search", () => {
  const present = {
    ...initialDesign,
    departments: initialDesign.departments.map((department, index) =>
      index === 0 ? { ...department, name: "Field operations" } : department,
    ),
  };
  const snapshot = readPlatformSnapshot(
    <T>(key: string, initial: T) =>
      (key === "sandbox.design"
        ? { past: [], present, future: [] }
        : initial) as T,
  );

  expect(snapshot.design).toEqual(present);
  expect(snapshot.design.departments[0]?.name).toBe("Field operations");
});
