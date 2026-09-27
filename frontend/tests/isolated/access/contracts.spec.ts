import { expect, test } from "@playwright/test";

import {
  departmentSchema,
  groupSchema,
  invitationCreateSchema,
  invitationSchema,
  invitationSettingsSchema,
  memberCandidateSchema,
  moduleSchema,
  pageSchema,
  sessionSchema,
  userAccessSchema,
  userPatchSchema,
  userSchema,
} from "../../../src/components/systems/access/state/api-contracts";
import {
  department,
  group,
  ids,
  memberCandidate,
  accessModule,
  pageOf,
  session,
  user,
  workspace,
} from "./fixtures";

test("responses shaped like the current backend models parse", () => {
  expect(userSchema.parse(user)).toEqual(user);
  expect(invitationSchema.parse({ user, delivery: "email" }).user).toEqual(
    user,
  );
  expect(groupSchema.parse(group)).toEqual(group);
  expect(memberCandidateSchema.parse(memberCandidate)).toEqual(memberCandidate);
  expect(sessionSchema.parse(session)).toEqual(session);
  expect(departmentSchema.parse(department)).toEqual(department);
  expect(moduleSchema.parse(accessModule)).toEqual(accessModule);
  expect(pageSchema(groupSchema).parse(pageOf([group])).items).toHaveLength(1);
});

test("users carry a role and no longer carry role ids, kinds, or departments", () => {
  for (const role of ["admin", "member", "guest"])
    expect(userSchema.safeParse({ ...user, role }).success, role).toBe(true);
  expect(userSchema.safeParse({ ...user, role: "owner" }).success).toBe(false);
  for (const removed of [
    { role_id: ids.admin },
    { identity_kind: "guest" },
    { department_ids: [ids.department] },
    { primary_department_id: ids.department },
  ])
    expect(
      userSchema.safeParse({ ...user, ...removed }).success,
      Object.keys(removed)[0],
    ).toBe(false);
});

test("group access entries allow a whole department or one module at three levels", () => {
  for (const level of ["read", "write", "manage"])
    expect(
      groupSchema.safeParse({
        ...group,
        access: [{ department_id: ids.department, module_id: null, level }],
      }).success,
      level,
    ).toBe(true);
  expect(
    groupSchema.safeParse({
      ...group,
      access: [
        { department_id: ids.department, module_id: null, level: "admin" },
      ],
    }).success,
  ).toBe(false);
  // The backend always sends module_id; a missing one is a contract change.
  expect(
    groupSchema.safeParse({
      ...group,
      access: [{ department_id: ids.department, level: "read" }],
    }).success,
  ).toBe(false);
  expect(groupSchema.safeParse({ ...group, extra: true }).success).toBe(false);
});

test("member candidates never include administrators", () => {
  expect(
    memberCandidateSchema.safeParse({ ...memberCandidate, role: "admin" })
      .success,
  ).toBe(false);
  expect(
    memberCandidateSchema.safeParse({ ...memberCandidate, job_title: "QA" })
      .success,
  ).toBe(false);
});

test("invitation settings read only their fields from the workspace resource", () => {
  expect(invitationSettingsSchema.parse(workspace)).toEqual({
    invitation_expiry_days: 7,
    guest_duration_days: 30,
    revision: 4,
  });
  expect(
    invitationSettingsSchema.safeParse({ ...workspace, guest_duration_days: 0 })
      .success,
  ).toBe(false);
});

test("commands accept only the fields the backend accepts", () => {
  expect(
    invitationCreateSchema.safeParse({
      email: "ana@example.com",
      username: "ana",
      role: "guest",
      group_ids: [ids.group],
      sponsor_user_id: ids.admin,
      expires_at: "2026-10-28T00:00:00Z",
    }).success,
  ).toBe(true);
  expect(
    invitationCreateSchema.safeParse({
      email: "ana@example.com",
      username: "ana smith",
    }).success,
  ).toBe(false);
  expect(
    invitationCreateSchema.safeParse({
      email: "ana@example.com",
      username: "ana",
      department_ids: [ids.department],
    }).success,
  ).toBe(false);
  expect(userPatchSchema.safeParse({ status: "pending" }).success).toBe(false);
  expect(userPatchSchema.safeParse({ role: "member" }).success).toBe(true);
});

test("a person's effective access names the level and the groups that give it", () => {
  const response = {
    user_id: ids.guest,
    role: "guest",
    unrestricted: false,
    entries: [
      {
        department_id: ids.department,
        module_id: null,
        level: "read",
        groups: [
          { group_id: ids.group, name: "Inventory clerks", level: "write" },
        ],
      },
    ],
  };
  expect(userAccessSchema.parse(response)).toEqual(response);
  expect(
    userAccessSchema.parse({
      ...response,
      role: "admin",
      unrestricted: true,
      entries: [],
    }).unrestricted,
  ).toBe(true);
  expect(userAccessSchema.safeParse({ ...response, extra: 1 }).success).toBe(
    false,
  );
  expect(
    userAccessSchema.safeParse({
      ...response,
      entries: [{ ...response.entries[0], level: "admin" }],
    }).success,
  ).toBe(false);
  // A missing module id or source list is a contract change.
  expect(
    userAccessSchema.safeParse({
      ...response,
      entries: [{ department_id: ids.department, level: "read", groups: [] }],
    }).success,
  ).toBe(false);
});
