import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import {
  createAccessGroup,
  deleteAccessGroup,
  deleteAccessUser,
  getAccessGroup,
  getAccessInvitationSettings,
  inviteAccessUser,
  listAccessDepartments,
  listAccessGroups,
  listAccessMemberCandidates,
  listAccessModules,
  listAccessUsers,
  listAccessUserSessions,
  replaceAccessGroupAccess,
  replaceAccessGroupMembers,
  resendAccessInvitation,
  restoreAccessUser,
  revokeAccessInvitation,
  revokeAccessUserSession,
  revokeAccessUserSessions,
  updateAccessGroup,
  updateAccessInvitationSettings,
  updateAccessUser,
} from "../../../src/components/systems/access/state/api";
import {
  department,
  group,
  ids,
  installCsrfCookie,
  installFetch,
  memberCandidate,
  accessModule,
  pageOf,
  session,
  user,
  workspace,
} from "./fixtures";

function sent(
  requests: { input: RequestInfo | URL; init?: RequestInit }[],
): [string, string | undefined][] {
  return requests.map(({ input, init }) => [String(input), init?.method]);
}

test("list reads send only the backend's query fields and forward the abort signal", async () => {
  const controller = new AbortController();
  const mock = installFetch((input) => {
    const path = new URL(String(input), "http://access.invalid").pathname;
    if (path === "/api/users") return Response.json(pageOf([user]));
    if (path === "/api/access/groups") return Response.json(pageOf([group]));
    if (path === "/api/access/member-candidates")
      return Response.json(pageOf([memberCandidate]));
    if (path === "/api/departments") return Response.json(pageOf([department]));
    if (path === "/api/modules") return Response.json(pageOf([accessModule]));
    return Response.json(pageOf([session]));
  });

  try {
    const signal = controller.signal;
    await listAccessUsers({ role: "guest", deleted: "include", signal });
    await listAccessGroups({ limit: 100, offset: 100, sort_by: "name" });
    await listAccessMemberCandidates({ search: "ana" });
    await listAccessDepartments({ deleted: "include" });
    await listAccessModules({ department_id: ids.department });
    await listAccessUserSessions(ids.guest, { limit: 10 });

    expect(sent(mock.requests).map(([path]) => path)).toEqual([
      "/api/users?deleted=include&role=guest",
      "/api/access/groups?limit=100&offset=100&sort_by=name",
      "/api/access/member-candidates?search=ana",
      "/api/departments?deleted=include",
      `/api/modules?department_id=${ids.department}`,
      `/api/users/${ids.guest}/sessions?limit=10`,
    ]);
    expect(mock.requests[0]?.init?.signal).toBe(signal);
    for (const request of mock.requests)
      expect(request.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("invitations send role and groups and never a password", async () => {
  const restoreCookie = installCsrfCookie("invite-token");
  const mock = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ user, delivery: "email" }, { status: 201 }),
  );

  try {
    await expect(
      inviteAccessUser({
        email: "ana@example.com",
        username: "ana",
        role: "guest",
        group_ids: [ids.group],
        sponsor_user_id: ids.admin,
      }),
    ).resolves.toEqual({ user, delivery: "email" });
    await resendAccessInvitation(ids.guest);
    await revokeAccessInvitation(ids.guest);

    expect(sent(mock.requests)).toEqual([
      ["/api/auth/invitations", "POST"],
      [`/api/auth/invitations/${ids.guest}/resend`, "POST"],
      [`/api/auth/invitations/${ids.guest}`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      email: "ana@example.com",
      username: "ana",
      role: "guest",
      group_ids: [ids.group],
      sponsor_user_id: ids.admin,
    });
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({});
    for (const request of mock.requests)
      expect(new Headers(request.init?.headers).get("X-CSRF-Token")).toBe(
        "invite-token",
      );

    // Removed fields are refused before any request is sent.
    await expect(
      inviteAccessUser({
        email: "ana@example.com",
        username: "ana",
        ...({ role_id: ids.admin } as object),
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(3);
  } finally {
    mock.restore();
    restoreCookie();
  }
});

test("user commands patch, delete, restore, and revoke sessions on the user routes", async () => {
  const restoreCookie = installCsrfCookie("user-token");
  const mock = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(user),
  );

  try {
    await updateAccessUser(ids.guest, { display_name: null, job_title: "QA" });
    await deleteAccessUser(ids.guest);
    await restoreAccessUser(ids.guest);
    await revokeAccessUserSession(ids.guest, ids.session);
    await revokeAccessUserSessions(ids.guest);

    expect(sent(mock.requests)).toEqual([
      [`/api/users/${ids.guest}`, "PATCH"],
      [`/api/users/${ids.guest}`, "DELETE"],
      [`/api/users/${ids.guest}/restore`, "POST"],
      [`/api/users/${ids.guest}/sessions/${ids.session}`, "DELETE"],
      [`/api/users/${ids.guest}/sessions`, "DELETE"],
    ]);
    // A null clears the field; an omitted field stays unchanged.
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      display_name: null,
      job_title: "QA",
    });

    // A role change cannot turn a person into a guest.
    await expect(
      updateAccessUser(ids.guest, {
        ...({ role: "guest" } as object),
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(5);
  } finally {
    mock.restore();
    restoreCookie();
  }
});

test("group writes carry If-Match and return the new ETag", async () => {
  const restoreCookie = installCsrfCookie("group-token");
  const mock = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(group, { headers: { ETag: '"group-4"' } }),
  );

  try {
    await expect(getAccessGroup(ids.group)).resolves.toEqual({
      data: group,
      etag: '"group-4"',
    });
    await createAccessGroup({ name: "  Inventory clerks ", member_ids: [] });
    await updateAccessGroup(ids.group, {
      description: "Stock",
      etag: '"group-3"',
    });
    await replaceAccessGroupAccess(ids.group, {
      access: group.access.map((entry) => ({
        ...entry,
        level: entry.level as "read" | "write",
      })),
      etag: '"group-3"',
    });
    await replaceAccessGroupMembers(ids.group, {
      member_ids: [ids.guest],
      etag: '"group-3"',
    });
    await deleteAccessGroup(ids.group, { etag: '"group-4"' });

    expect(sent(mock.requests)).toEqual([
      [`/api/access/groups/${ids.group}`, undefined],
      ["/api/access/groups", "POST"],
      [`/api/access/groups/${ids.group}`, "PATCH"],
      [`/api/access/groups/${ids.group}/access`, "PUT"],
      [`/api/access/groups/${ids.group}/members`, "PUT"],
      [`/api/access/groups/${ids.group}`, "DELETE"],
    ]);
    const ifMatch = mock.requests.map((request) =>
      new Headers(request.init?.headers).get("If-Match"),
    );
    expect(ifMatch).toEqual([
      null,
      null,
      '"group-3"',
      '"group-3"',
      '"group-3"',
      '"group-4"',
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      name: "Inventory clerks",
      member_ids: [],
    });
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      access: group.access,
    });
    expect(JSON.parse(String(mock.requests[4]?.init?.body))).toEqual({
      member_ids: [ids.guest],
    });

    // Members no longer change through PATCH (D14).
    await expect(
      updateAccessGroup(ids.group, {
        ...({ member_ids: [] } as object),
        etag: '"group-4"',
      }),
    ).rejects.toThrow();
    // A missing version is refused before the request is sent.
    await expect(
      updateAccessGroup(ids.group, { name: "Clerks", etag: " " }),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(mock.requests).toHaveLength(6);
  } finally {
    mock.restore();
    restoreCookie();
  }
});

test("a versioned group read fails closed without an ETag", async () => {
  const mock = installFetch(() => Response.json(group));
  try {
    await expect(getAccessGroup(ids.group)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("invitation settings read the workspace and save with its revision in the body", async () => {
  const restoreCookie = installCsrfCookie("settings-token");
  const mock = installFetch(() =>
    Response.json({ ...workspace, guest_duration_days: 45, revision: 5 }),
  );

  try {
    await expect(getAccessInvitationSettings()).resolves.toEqual({
      invitation_expiry_days: 7,
      guest_duration_days: 45,
      revision: 5,
    });
    await updateAccessInvitationSettings({
      revision: 4,
      guest_duration_days: 45,
    });

    expect(sent(mock.requests)).toEqual([
      ["/api/workspace", undefined],
      ["/api/workspace", "PATCH"],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      revision: 4,
      guest_duration_days: 45,
    });
    expect(
      new Headers(mock.requests[1]?.init?.headers).get("If-Match"),
    ).toBeNull();

    // A save must change at least one setting, within the backend's bounds.
    await expect(
      updateAccessInvitationSettings({ revision: 4 }),
    ).rejects.toThrow();
    await expect(
      updateAccessInvitationSettings({ revision: 4, guest_duration_days: 366 }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(2);
  } finally {
    mock.restore();
    restoreCookie();
  }
});
