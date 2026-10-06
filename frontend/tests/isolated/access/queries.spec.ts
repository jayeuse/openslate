import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";

import {
  accessKeys,
  afterAccessGroupChange,
  afterAccessUserChange,
  afterInvitationSettingsChange,
  authMeOptions,
  departmentListOptions,
  groupListOptions,
  invitationSettingsOptions,
  memberCandidateListOptions,
  moduleListOptions,
  userAccessOptions,
  userListOptions,
  userSessionsOptions,
} from "../../../src/components/systems/access/adapters/access-queries";
import { installFetch, pagination, user, directoryUser } from "./fixtures";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("every Access key starts with the area and holds its list filter", () => {
  const keys = [
    userListOptions("exclude").queryKey,
    groupListOptions("include").queryKey,
    memberCandidateListOptions().queryKey,
    departmentListOptions("include").queryKey,
    moduleListOptions("exclude").queryKey,
    invitationSettingsOptions().queryKey,
  ];
  for (const key of keys) expect(key[0]).toBe("access");
  expect(userListOptions("exclude").queryKey).not.toEqual(
    userListOptions("include").queryKey,
  );
  expect(groupListOptions("only").queryKey).toContain("only");
  // The identity key is shared with OpenView and the navigation.
  expect(authMeOptions().queryKey).toEqual(["auth", "me"]);
});

test("a list read loads every page into one complete collection", async () => {
  const second = {
    ...directoryUser,
    id: "00000000-0000-4000-8000-0000000000f2",
  };
  const mock = installFetch((input) => {
    const offset = Number(
      new URL(String(input), "http://access.invalid").searchParams.get(
        "offset",
      ),
    );
    return Response.json({
      items: [offset === 0 ? directoryUser : second],
      pagination: {
        ...pagination,
        limit: 100,
        offset,
        total: 2,
        has_more: offset === 0,
      },
    });
  });

  try {
    const users = await client().fetchQuery(userListOptions("include"));
    expect(users.map((item) => item.id)).toEqual([user.id, second.id]);
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/users?limit=100&offset=0&sort_by=username&deleted=include",
      "/api/users?limit=100&offset=1&sort_by=username&deleted=include",
    ]);
  } finally {
    mock.restore();
  }
});

test("confirmed commands mark only the reads they change as stale", async () => {
  const queries = client();
  const seed = (key: readonly unknown[]) => queries.setQueryData(key, []);
  seed(accessKeys.userList("exclude"));
  seed(accessKeys.groupList("exclude"));
  seed(accessKeys.memberCandidates());
  seed(accessKeys.departments("include"));
  seed(accessKeys.userAccess(user.id));
  queries.setQueryData(authMeOptions().queryKey, {
    id: user.id,
    role: "admin",
    access: [],
  });
  const stale = () =>
    queries
      .getQueryCache()
      .findAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => query.queryKey);

  await afterAccessGroupChange(queries);
  expect(stale()).toEqual([
    accessKeys.groupList("exclude"),
    accessKeys.userAccess(user.id),
    authMeOptions().queryKey,
  ]);

  await afterAccessUserChange(queries);
  expect(stale()).toHaveLength(5);
  expect(stale()).not.toContainEqual(accessKeys.departments("include"));
});

test("saved invitation settings replace the cached settings at once", () => {
  const queries = client();
  afterInvitationSettingsChange(queries, {
    invitation_expiry_days: 14,
    guest_duration_days: 30,
    revision: 5,
  });
  expect(queries.getQueryData(accessKeys.invitationSettings())).toEqual({
    invitation_expiry_days: 14,
    guest_duration_days: 30,
    revision: 5,
  });
});

test("a person's access and sessions sit under the users key", () => {
  expect(userAccessOptions("u1").queryKey).toEqual([
    "access",
    "users",
    "access",
    "u1",
  ]);
  expect(userSessionsOptions("u1").queryKey).toEqual([
    "access",
    "users",
    "sessions",
    "u1",
  ]);
});
