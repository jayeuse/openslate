import { expect, test } from "@playwright/test";
import {
  displayIdentityStatus,
  type InternalIdentity,
} from "../../../src/components/systems/access/domain/policy";

import {
  AuthoritativeAccessLoadError,
  loadAllAccessPages,
  loadAllVersionedAccessPages,
  loadAuthoritativeAccessSnapshot,
  loadVersionedAccessDetails,
  mapAuthoritativeAccessSnapshot,
  mapAuthoritativeScopeCatalog,
  type AuthoritativeAccessAdapters,
  type AuthoritativeAccessResources,
} from "../../../src/components/systems/access/state/authoritative";

const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  guest: "00000000-0000-4000-8000-000000000002",
  roleAdmin: "00000000-0000-4000-8000-000000000003",
  roleMember: "00000000-0000-4000-8000-000000000004",
  department: "00000000-0000-4000-8000-000000000005",
  group: "00000000-0000-4000-8000-000000000006",
  defaults: "00000000-0000-4000-8000-000000000007",
  service: "00000000-0000-4000-8000-000000000008",
  ruleUser: "00000000-0000-4000-8000-000000000009",
  ruleService: "00000000-0000-4000-8000-000000000010",
};
const timestamp = "2026-09-23T00:00:00Z";

test("expired people are not displayed as active while stored status stays editable", () => {
  const person: InternalIdentity = {
    kind: "internal",
    id: ids.admin,
    name: "Expired administrator",
    email: "expired@example.com",
    status: "active",
    roleId: ids.roleAdmin,
    groupIds: [],
    departmentIds: [],
    primaryDepartmentId: "",
    title: "",
    expiresAt: "2000-01-01T00:00:00Z",
  };

  expect(displayIdentityStatus(person)).toBe("expired");
  expect(
    displayIdentityStatus({
      ...person,
      kind: "guest",
      sponsorId: ids.guest,
      expiresAt: "2000-01-01T00:00:00Z",
    }),
  ).toBe("expired");
  expect(displayIdentityStatus({ ...person, status: "disabled" })).toBe(
    "disabled",
  );
  expect(
    displayIdentityStatus({ ...person, expiresAt: "9999-01-01T00:00:00Z" }),
  ).toBe("active");
  expect(person.status).toBe("active");
});

function page<Item>(items: Item[], offset: number, total: number) {
  return {
    items,
    pagination: {
      limit: 100,
      offset,
      count: items.length,
      total,
      has_more: offset + items.length < total,
    },
  };
}

test("loads every page once and forwards an abort signal", async () => {
  const controller = new AbortController();
  const offsets: number[] = [];
  const signals: AbortSignal[] = [];

  const items = await loadAllAccessPages(
    async ({ limit, offset, signal }) => {
      expect(limit).toBe(100);
      offsets.push(offset);
      if (signal) signals.push(signal);
      return offset === 0
        ? page([{ id: "first" }], 0, 2)
        : page([{ id: "second" }], 1, 2);
    },
    { signal: controller.signal },
  );

  expect(items).toEqual([{ id: "first" }, { id: "second" }]);
  expect(offsets).toEqual([0, 1]);
  expect(signals).toEqual([controller.signal, controller.signal]);

  controller.abort();
  await expect(
    loadAllAccessPages(async () => page([], 0, 0), {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("fails closed when a paginated policy list changes its workspace ETag", async () => {
  await expect(
    loadAllVersionedAccessPages(async ({ offset }) => ({
      data: page(
        [{ id: `00000000-0000-4000-8000-0000000000${offset + 1}` }],
        offset,
        2,
      ),
      etag: offset === 0 ? '"workspace:3"' : '"workspace:4"',
    })),
  ).rejects.toThrow("Access policy changed during pagination");
});

test("offers only scopes enforced by the authoritative access policy", () => {
  expect(mapAuthoritativeScopeCatalog()).toEqual([
    {
      kind: "workspace",
      id: "workspace",
      name: "Workspace",
      product: "Sandbox/core",
    },
  ]);
});

test("rejects repeated, non-progressing, inconsistent, and over-bound pages", async () => {
  await expect(
    loadAllAccessPages(async ({ offset }) =>
      page([{ id: "repeat" }], offset, 2),
    ),
  ).rejects.toBeInstanceOf(AuthoritativeAccessLoadError);
  await expect(
    loadAllAccessPages(async ({ offset }) => ({
      ...page([], offset, 1),
      pagination: { ...page([], offset, 1).pagination, has_more: true },
    })),
  ).rejects.toBeInstanceOf(AuthoritativeAccessLoadError);
  await expect(
    loadAllAccessPages(async ({ offset }) =>
      page([{ id: `${offset}` }], offset + 1, 1),
    ),
  ).rejects.toBeInstanceOf(AuthoritativeAccessLoadError);
  await expect(
    loadAllAccessPages(async ({ offset }) =>
      page([{ id: `${offset}` }], offset, 2001),
    ),
  ).rejects.toBeInstanceOf(AuthoritativeAccessLoadError);
});

test("loads the seven authoritative resources in parallel without local fallbacks", async () => {
  const controller = new AbortController();
  const called: string[] = [];
  const listedGroup = {
    id: ids.group,
    name: "List group",
    description: "",
    revision: 1,
    member_ids: [],
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
  const listedService = {
    id: ids.service,
    name: "List service",
    purpose: "List purpose",
    owner_id: ids.admin,
    role_id: ids.roleMember,
    expires_at: "2026-12-23T00:00:00Z",
    status: "active" as const,
    effective_status: "active" as const,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
  const emptyPage = async (name: string, signal?: AbortSignal) => {
    called.push(name);
    expect(signal).toBe(controller.signal);
    return page([], 0, 0);
  };

  const adapters: AuthoritativeAccessAdapters = {
    capabilities: async ({ signal }) => {
      called.push("capabilities");
      expect(signal).toBe(controller.signal);
      return { items: [] };
    },
    users: ({ signal }) => emptyPage("users", signal),
    roles: ({ signal }) => emptyPage("roles", signal),
    departments: ({ signal, deleted }) => {
      expect(deleted).toBe("include");
      return emptyPage("departments", signal);
    },
    groups: async ({ signal }) => {
      called.push("groups");
      expect(signal).toBe(controller.signal);
      return page([listedGroup], 0, 1);
    },
    defaults: async ({ signal }) => {
      called.push("defaults");
      expect(signal).toBe(controller.signal);
      return {
        data: {
          id: ids.defaults,
          default_role_id: ids.roleMember,
          group_ids: [],
          department_ids: [],
          invitation_expiry_days: 7,
          guest_duration_days: 30,
          service_duration_days: 90,
          default_deny: true,
          require_guest_sponsor: true,
          require_service_owner: true,
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
        etag: '"defaults-1"',
      };
    },
    services: async ({ signal }) => {
      called.push("services");
      expect(signal).toBe(controller.signal);
      return page([listedService], 0, 1);
    },
    group: async (id, { signal }) => {
      expect(id).toBe(ids.group);
      expect(signal).toBe(controller.signal);
      return {
        data: { ...listedGroup, name: "Detail group" },
        etag: '"group-1"',
      };
    },
    service: async (id, { signal }) => {
      expect(id).toBe(ids.service);
      expect(signal).toBe(controller.signal);
      return {
        data: { ...listedService, purpose: "Detail purpose" },
        etag: '"service-1"',
      };
    },
    rules: async ({ signal }) => {
      called.push("rules");
      expect(signal).toBe(controller.signal);
      return { data: page([], 0, 0), etag: '"workspace:1"' };
    },
  };
  const result = await loadAuthoritativeAccessSnapshot(
    { signal: controller.signal },
    adapters,
  );

  expect(called.sort()).toEqual([
    "capabilities",
    "defaults",
    "departments",
    "groups",
    "roles",
    "rules",
    "services",
    "users",
  ]);
  expect(result.snapshot).toMatchObject({
    people: [],
    roles: [],
    guests: [],
    services: [{ id: ids.service, purpose: "Detail purpose" }],
    groups: [{ id: ids.group, name: "Detail group" }],
    rules: [],
    templates: [],
    reviews: [],
    sessions: [],
    history: [],
  });
  expect(result.versions.groups).toEqual({ [ids.group]: '"group-1"' });
  expect(result.versions.services).toEqual({ [ids.service]: '"service-1"' });
  await expect(
    loadAuthoritativeAccessSnapshot(
      { signal: controller.signal },
      {
        ...adapters,
        group: async () => {
          throw new Error("detail failed");
        },
      },
    ),
  ).rejects.toThrow("detail failed");
});

test("versioned details replace stale list data in stable order", async () => {
  const list = [
    { id: "one", value: "list-one" },
    { id: "two", value: "list-two" },
  ];

  const result = await loadVersionedAccessDetails(list, async (id) => ({
    data: { id, value: `detail-${id}` },
    etag: `"${id}-etag"`,
  }));

  expect(result.items).toEqual([
    { id: "one", value: "detail-one" },
    { id: "two", value: "detail-two" },
  ]);
  expect(result.etags).toEqual({ one: '"one-etag"', two: '"two-etag"' });
});

test("versioned detail reads are batched, fail closed, and propagate aborts", async () => {
  let active = 0;
  let maximumActive = 0;
  const list = Array.from({ length: 17 }, (_, index) => ({ id: `${index}` }));
  const batched = await loadVersionedAccessDetails(list, async (id) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { data: { id }, etag: `"${id}"` };
  });
  expect(maximumActive).toBeLessThanOrEqual(8);
  expect(batched.items.map((item) => item.id)).toEqual(
    list.map((item) => item.id),
  );

  await expect(
    loadVersionedAccessDetails([{ id: "missing" }], async () => ({
      data: { id: "missing" },
      etag: "",
    })),
  ).rejects.toBeInstanceOf(AuthoritativeAccessLoadError);
  await expect(
    loadVersionedAccessDetails(
      [{ id: "absent" }],
      async () => ({ data: { id: "absent" } }) as never,
    ),
  ).rejects.toBeInstanceOf(AuthoritativeAccessLoadError);
  await expect(
    loadVersionedAccessDetails([{ id: "failed" }], async () => {
      throw new Error("detail failed");
    }),
  ).rejects.toThrow("detail failed");

  const controller = new AbortController();
  await expect(
    loadVersionedAccessDetails(
      [{ id: "aborted" }],
      async (id, options) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort();
        return { data: { id }, etag: '"aborted"' };
      },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("maps authoritative pending invitations without a send timestamp as revoked", () => {
  const revokedGuest = Object.assign(
    {
      id: ids.guest,
      email: "guest@example.com",
      username: "guest",
      status: "pending" as const,
      role_id: ids.roleMember,
      display_name: null,
      identity_kind: "guest" as const,
      job_title: null,
      sponsor_user_id: ids.admin,
      expires_at: "2026-10-23T00:00:00Z",
      department_ids: [],
      primary_department_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      is_deleted: false,
      performed_by: null,
    },
    { invitation_sent_at: null },
  );
  const resources: AuthoritativeAccessResources = {
    capabilities: [
      {
        id: "records.read",
        label: "View records",
        description: "View saved records.",
        group: "Records",
      },
      {
        id: "departments.write",
        label: "Manage departments",
        description: "Change departments.",
        group: "Departments",
      },
    ],
    users: [
      {
        id: ids.admin,
        email: "admin@example.com",
        username: "admin",
        status: "active",
        role_id: ids.roleAdmin,
        display_name: "Ada Admin",
        identity_kind: "internal",
        job_title: "Director",
        sponsor_user_id: null,
        expires_at: null,
        department_ids: [ids.department],
        primary_department_id: ids.department,
        invitation_sent_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
      revokedGuest,
    ],
    roles: [
      {
        id: ids.roleAdmin,
        role: "admin",
        description: null,
        permissions: { "records.read": true },
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
      {
        id: ids.roleMember,
        role: "member",
        description: "Standard staff",
        permissions: { "records.read": true },
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
    departments: [
      {
        id: ids.department,
        department_name: "Operations",
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
    groups: [
      {
        id: ids.group,
        name: "Operations team",
        description: "",
        revision: 2,
        member_ids: [ids.admin, ids.guest],
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
    defaults: {
      data: {
        id: ids.defaults,
        default_role_id: ids.roleMember,
        group_ids: [ids.group],
        department_ids: [ids.department],
        invitation_expiry_days: 7,
        guest_duration_days: 30,
        service_duration_days: 90,
        default_deny: true,
        require_guest_sponsor: true,
        require_service_owner: true,
        revision: 3,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
      etag: '"defaults-3"',
    },
    services: [
      {
        id: ids.service,
        name: "Reporting service",
        purpose: "Creates reports.",
        owner_id: ids.admin,
        role_id: ids.roleMember,
        expires_at: "2026-12-23T00:00:00Z",
        status: "active",
        effective_status: "expired",
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
    groupEtags: { [ids.group]: '"group-2"' },
    serviceEtags: { [ids.service]: '"service-1"' },
    rules: [
      {
        id: ids.ruleUser,
        subject_kind: "user",
        subject_id: ids.admin,
        scope_kind: "workspace",
        scope_id: null,
        permission_id: "records.read",
        decision: "allow",
        starts_at: null,
        ends_at: null,
        locked: false,
        policy_version: 3,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
      {
        id: ids.ruleService,
        subject_kind: "service",
        subject_id: ids.service,
        scope_kind: "department",
        scope_id: ids.department,
        permission_id: "records.read",
        decision: "deny",
        starts_at: null,
        ends_at: null,
        locked: true,
        policy_version: 3,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
    policyEtag: '"workspace:3"',
  };
  const result = mapAuthoritativeAccessSnapshot(resources);

  expect(result.snapshot.people).toEqual([
    {
      id: ids.admin,
      name: "Ada Admin",
      email: "admin@example.com",
      role: ids.roleAdmin,
      active: true,
      accessStatus: "active",
      departments: ["Operations"],
      departmentIds: [ids.department],
      primary: "Operations",
      primaryDepartmentId: ids.department,
      title: "Director",
      activity: [],
      groupIds: [ids.group],
    },
  ]);
  expect(result.snapshot.guests[0]).toMatchObject({
    id: ids.guest,
    name: "guest",
    status: "revoked",
    groupIds: [ids.group],
    invitation: { sentAt: "", resendCount: 0 },
  });
  expect(result.snapshot.services[0]).toMatchObject({
    id: ids.service,
    status: "active",
    effectiveStatus: "expired",
    expiresAt: "2026-12-23T00:00:00Z",
    groupIds: [],
  });
  expect(displayIdentityStatus(result.snapshot.services[0]!)).toBe("expired");
  expect(result.snapshot.roles).toEqual([
    {
      id: ids.roleAdmin,
      name: "admin",
      builtin: true,
      grants: ["records.read", "departments.write"],
    },
    {
      id: ids.roleMember,
      name: "member",
      description: "Standard staff",
      builtin: true,
      grants: ["records.read"],
    },
  ]);
  expect(result.snapshot.rules).toEqual([
    expect.objectContaining({
      id: ids.ruleUser,
      subject: { kind: "identity", id: ids.admin },
      scope: { kind: "workspace", id: "workspace" },
    }),
    expect.objectContaining({
      id: ids.ruleService,
      subject: { kind: "identity", id: ids.service },
      scope: { kind: "department", id: ids.department },
    }),
  ]);
  expect(result.snapshot.templates).toEqual([]);
  expect(result.snapshot.reviews).toEqual([]);
  expect(result.snapshot.sessions).toEqual([]);
  expect(result.snapshot.history).toEqual([]);
  expect(result.snapshot.deletedIdentities).toEqual([]);
  expect(result.capabilities).toEqual([
    {
      id: "records.read",
      label: "View records",
      description: "View saved records.",
      group: "Records",
    },
    {
      id: "departments.write",
      label: "Manage departments",
      description: "Change departments.",
      group: "Departments",
    },
  ]);
  expect(result.departments).toEqual([
    expect.objectContaining({
      id: ids.department,
      department_name: "Operations",
    }),
  ]);
  const closed = mapAuthoritativeAccessSnapshot({
    ...resources,
    departments: resources.departments.map((department) => ({
      ...department,
      is_deleted: true,
      deleted_at: timestamp,
    })),
    defaults: {
      ...resources.defaults,
      data: { ...resources.defaults.data, department_ids: [] },
    },
  });
  expect(closed.snapshot.people[0]).toMatchObject({
    departments: ["Operations"],
    departmentIds: [ids.department],
    primary: "Operations",
    primaryDepartmentId: ids.department,
  });
  expect(closed.departments).toEqual([]);
  expect(result.versions).toEqual({
    defaults: '"defaults-3"',
    groups: { [ids.group]: '"group-2"' },
    services: { [ids.service]: '"service-1"' },
    policy: '"workspace:3"',
    ruleSubjectKinds: { [ids.ruleUser]: "user", [ids.ruleService]: "service" },
  });
  expect(JSON.stringify(result)).not.toContain("sample-");
});
