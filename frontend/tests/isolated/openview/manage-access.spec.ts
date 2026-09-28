import { expect, test } from "@playwright/test";
import type { AuthMe } from "../../../src/lib/auth-api";
import {
  canManageOpenView,
  managedDepartmentIds,
  openViewLevel,
} from "../../../src/components/systems/openview/domain/manage-access";

const inventory = "00000000-0000-4000-8000-0000000000a1";
const finance = "00000000-0000-4000-8000-0000000000a2";
const prices = "00000000-0000-4000-8000-0000000000b1";
const stock = "00000000-0000-4000-8000-0000000000b2";

function member(
  access: AuthMe["access"],
  role: AuthMe["role"] = "member",
): AuthMe {
  return { id: "00000000-0000-4000-8000-000000000001", role, access };
}

test("only manage on the department or the module shows OpenView change controls", () => {
  const reader = member([
    { departmentId: inventory, moduleId: null, level: "read" },
    { departmentId: inventory, moduleId: prices, level: "manage" },
  ]);

  expect(canManageOpenView(reader, inventory)).toBe(false);
  expect(canManageOpenView(reader, inventory, stock)).toBe(false);
  expect(canManageOpenView(reader, inventory, prices)).toBe(true);
  expect(canManageOpenView(reader, finance, prices)).toBe(false);
  expect(canManageOpenView(member([]), inventory)).toBe(false);
  expect(canManageOpenView(undefined, inventory)).toBe(false);
  expect(canManageOpenView(member([], "admin"), finance, prices)).toBe(true);
});

test("a module entry wins over its department entry and a guest only reads", () => {
  const writer = member([
    { departmentId: inventory, moduleId: null, level: "manage" },
    { departmentId: inventory, moduleId: prices, level: "read" },
  ]);
  expect(openViewLevel(writer, inventory, prices)).toBe("read");
  expect(openViewLevel(writer, inventory, stock)).toBe("manage");

  const guest = member(
    [{ departmentId: inventory, moduleId: null, level: "manage" }],
    "guest",
  );
  expect(openViewLevel(guest, inventory)).toBe("read");
  expect(canManageOpenView(guest, inventory)).toBe(false);
  expect(managedDepartmentIds(guest)).toEqual(new Set());
});

test("Dashboards can be created only in departments managed by a department row", () => {
  const manager = member([
    { departmentId: inventory, moduleId: null, level: "manage" },
    { departmentId: finance, moduleId: prices, level: "manage" },
  ]);
  expect(managedDepartmentIds(manager)).toEqual(new Set([inventory]));
  expect(managedDepartmentIds(member([], "admin"))).toBe("all");
});
