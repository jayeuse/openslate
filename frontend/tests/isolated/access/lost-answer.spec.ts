import { expect, test } from "@playwright/test";

import { groupMadeByLostCreate } from "../../../src/components/systems/access/helpers/groups";
import { invitationMadeByLostInvite } from "../../../src/components/systems/access/helpers/people";
import type { AccessGroup } from "../../../src/components/systems/access/state/api-contracts";
import { group, user } from "./fixtures";

// After Create group or Invite gets no answer, the page checks the server
// for what the request made before it offers Retry.

// The browser started the request at 10:00; the server's clock is behind.
const startedAt = Date.parse("2026-09-28T10:00:00Z");

function named(id: string, name: string, isDeleted = false): AccessGroup {
  return {
    ...(group as AccessGroup),
    id,
    name,
    created_at: "2026-09-28T09:58:00Z",
    is_deleted: isDeleted,
  };
}

test("a lost create opens the same-name group that was not there before, whatever the clocks say", () => {
  const older = named("00000000-0000-4000-8000-0000000000b1", "Dispatch");
  const other = named("00000000-0000-4000-8000-0000000000b2", "Dispatch team");
  const deleted = named(
    "00000000-0000-4000-8000-0000000000b3",
    "Dispatch",
    true,
  );
  const made = named("00000000-0000-4000-8000-0000000000b4", "Dispatch");
  const before = new Set([older.id]);
  expect(Date.parse(made.created_at)).toBeLessThan(startedAt);
  expect(
    groupMadeByLostCreate([older, other, deleted], " Dispatch ", before),
  ).toBeNull();
  expect(
    groupMadeByLostCreate([older, other, deleted, made], "Dispatch", before)
      ?.id,
  ).toBe("00000000-0000-4000-8000-0000000000b4");
});

test("a lost invitation opens only the pending person with that email", () => {
  const active = {
    ...user,
    email: "eve@example.com",
    status: "active" as const,
  };
  const deleted = {
    ...user,
    id: "00000000-0000-4000-8000-0000000000c1",
    email: "eve@example.com",
    status: "pending" as const,
    is_deleted: true,
  };
  const pending = {
    ...user,
    id: "00000000-0000-4000-8000-0000000000c2",
    email: "Eve@Example.com",
    status: "pending" as const,
  };
  expect(
    invitationMadeByLostInvite([active, deleted], "eve@example.com"),
  ).toBeNull();
  expect(
    invitationMadeByLostInvite([active, deleted, pending], " eve@example.com ")
      ?.id,
  ).toBe("00000000-0000-4000-8000-0000000000c2");
});
