import type { Page, Route } from "@playwright/test";

// A mocked Access API for the People, Groups and Overview HTTP specs. Every
// response matches the strict frontend contracts, and every list answers
// with the 100-item pages the complete-collection loader expects. Groups
// carry an ETag ("<id>:<revision>") and refuse a stale If-Match with 412,
// like the backend.

export const DAY = 86_400_000;
export const at = (offset: number) =>
  new Date(Date.now() + offset).toISOString();
export const created = "2026-01-10T09:00:00Z";

export const ids = {
  rosa: "00000000-0000-4000-8000-000000000101",
  ana: "00000000-0000-4000-8000-000000000102",
  ben: "00000000-0000-4000-8000-000000000103",
  cy: "00000000-0000-4000-8000-000000000104",
  dee: "00000000-0000-4000-8000-000000000105",
  eli: "00000000-0000-4000-8000-000000000106",
  clerks: "00000000-0000-4000-8000-0000000000a1",
  readers: "00000000-0000-4000-8000-0000000000a2",
  inventory: "00000000-0000-4000-8000-0000000000d1",
  finance: "00000000-0000-4000-8000-0000000000d2",
  prices: "00000000-0000-4000-8000-0000000000e1",
  laptop: "00000000-0000-4000-8000-0000000000f1",
  phone: "00000000-0000-4000-8000-0000000000f2",
};

export type User = {
  id: string;
  email: string;
  username: string;
  status: "pending" | "active" | "disabled";
  role: "admin" | "member" | "guest";
  display_name: string | null;
  job_title: string | null;
  sponsor_user_id: string | null;
  expires_at: string | null;
  invitation_sent_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export function person(
  fields: Partial<User> & Pick<User, "id" | "username">,
): User {
  return {
    email: `${fields.username}@example.com`,
    status: "active",
    role: "member",
    display_name: null,
    job_title: null,
    sponsor_user_id: null,
    expires_at: null,
    invitation_sent_at: created,
    created_at: created,
    updated_at: created,
    deleted_at: null,
    is_deleted: false,
    performed_by: ids.rosa,
    ...fields,
  };
}

export type AccessEntry = {
  department_id: string;
  module_id: string | null;
  level: "read" | "write" | "manage";
};
export type Group = ReturnType<typeof group>;

export function group(
  id: string,
  name: string,
  members: string[],
  access: AccessEntry[],
) {
  return {
    id,
    name,
    description: "",
    revision: 1,
    member_ids: members,
    access,
    created_at: created,
    updated_at: created,
    deleted_at: null as string | null,
    is_deleted: false,
    performed_by: ids.rosa,
  };
}

const catalogFields = {
  created_at: created,
  updated_at: created,
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.rosa,
};

export function listPage(items: object[], url: URL) {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const slice = items.slice(offset, offset + 100);
  return {
    items: slice,
    pagination: {
      limit: 100,
      offset,
      count: slice.length,
      total: items.length,
      has_more: offset + slice.length < items.length,
    },
  };
}

export type Call = { method: string; path: string; body: unknown };
export type Handler = (
  route: Route,
  call: Call,
) => Promise<void | "next"> | void | "next";

export type MockOptions = {
  /** The signed-in person; an administrator by default. */
  identity?: { id: string; role: User["role"]; access: AccessEntry[] };
};

export type Workspace = {
  invitation_expiry_days: number;
  guest_duration_days: number;
  revision: number;
  display_name: string;
};

export type Api = {
  users: Map<string, User>;
  groups: Map<string, Group>;
  workspace: Workspace;
  calls: Call[];
  /** Override one method and path; return "next" to use the default. */
  on: (method: string, path: string, handler: Handler) => void;
  sent: (method: string, path: string) => Call[];
};

export async function mockAccessApi(
  page: Page,
  options: MockOptions = {},
): Promise<Api> {
  const users = new Map<string, User>(
    [
      person({
        id: ids.rosa,
        username: "rosa",
        role: "admin",
        display_name: "Rosa Reyes",
      }),
      person({
        id: ids.ana,
        username: "ana",
        role: "guest",
        display_name: "Ana Santos",
        job_title: "Auditor",
        sponsor_user_id: ids.rosa,
        expires_at: at(5 * DAY),
      }),
      person({
        id: ids.ben,
        username: "ben",
        display_name: "Ben Cruz",
        job_title: "Clerk",
      }),
      person({
        id: ids.cy,
        username: "cy",
        status: "pending",
        invitation_sent_at: null,
      }),
      person({
        id: ids.dee,
        username: "dee",
        role: "admin",
        display_name: "Dee Lim",
      }),
      person({
        id: ids.eli,
        username: "eli",
        display_name: "Eli Tan",
        status: "disabled",
        is_deleted: true,
        deleted_at: created,
      }),
    ].map((user) => [user.id, user]),
  );
  const groups = new Map<string, Group>(
    [
      group(
        ids.clerks,
        "Inventory clerks",
        [ids.ana, ids.ben],
        [{ department_id: ids.inventory, module_id: null, level: "write" }],
      ),
      group(
        ids.readers,
        "Finance readers",
        [ids.ben],
        [{ department_id: ids.finance, module_id: null, level: "read" }],
      ),
    ].map((item) => [item.id, item]),
  );
  const departments = [
    { id: ids.inventory, department_name: "Inventory", ...catalogFields },
    { id: ids.finance, department_name: "Finance", ...catalogFields },
  ];
  const modules = [
    {
      id: ids.prices,
      department_id: ids.inventory,
      module_name: "Prices",
      ...catalogFields,
    },
  ];
  const sessions = [
    {
      id: ids.laptop,
      created_at: created,
      refreshed_at: at(-DAY),
      expires_at: at(20 * DAY),
      user_agent: "Laptop browser",
      current: false,
    },
    {
      id: ids.phone,
      created_at: created,
      refreshed_at: at(-2 * DAY),
      expires_at: at(20 * DAY),
      user_agent: "Phone browser",
      current: false,
    },
  ];
  const access: Record<string, object> = {
    [ids.ana]: {
      user_id: ids.ana,
      role: "guest",
      unrestricted: false,
      entries: [
        {
          department_id: ids.inventory,
          module_id: null,
          level: "read",
          groups: [
            { group_id: ids.clerks, name: "Inventory clerks", level: "write" },
          ],
        },
      ],
    },
    [ids.ben]: {
      user_id: ids.ben,
      role: "member",
      unrestricted: false,
      entries: [
        {
          department_id: ids.inventory,
          module_id: ids.prices,
          level: "write",
          groups: [
            { group_id: ids.clerks, name: "Inventory clerks", level: "write" },
          ],
        },
      ],
    },
    [ids.dee]: {
      user_id: ids.dee,
      role: "admin",
      unrestricted: true,
      entries: [],
    },
  };
  const calls: Call[] = [];
  const handlers = new Map<string, Handler>();
  const api: Api = {
    users,
    groups,
    workspace: {
      invitation_expiry_days: 7,
      guest_duration_days: 45,
      revision: 3,
      display_name: "Northwind",
    },
    calls,
    on: (method, path, handler) => handlers.set(`${method} ${path}`, handler),
    sent: (method, path) =>
      calls.filter((call) => call.method === method && call.path === path),
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    const call = { method, path, body };
    calls.push(call);
    const override = handlers.get(`${method} ${path}`);
    if (override && (await override(route, call)) !== "next") return;

    if (path === "/api/auth/session")
      return route.fulfill({
        json: { authenticated: true, user_id: ids.rosa, setup_required: false },
      });
    if (path === "/api/auth/me")
      return route.fulfill({
        json: options.identity ?? { id: ids.rosa, role: "admin", access: [] },
      });
    if (path === "/api/users" && method === "GET")
      return route.fulfill({ json: listPage([...users.values()], url) });
    if (path === "/api/access/groups" && method === "GET")
      return route.fulfill({
        json: listPage(
          [...groups.values()].filter((item) => !item.is_deleted),
          url,
        ),
      });
    if (path === "/api/access/groups" && method === "POST") {
      const input = body as {
        name: string;
        description?: string;
        member_ids?: string[];
      };
      const made = {
        ...group(
          "00000000-0000-4000-8000-0000000000a9",
          input.name,
          input.member_ids ?? [],
          [],
        ),
        description: input.description ?? "",
      };
      groups.set(made.id, made);
      return route.fulfill({
        status: 201,
        headers: { ETag: etag(made) },
        json: made,
      });
    }
    if (path === "/api/access/member-candidates")
      return route.fulfill({
        json: listPage(
          [...users.values()]
            .filter((user) => user.role !== "admin" && !user.is_deleted)
            .map((user) => ({
              id: user.id,
              display_name: user.display_name,
              username: user.username,
              email: user.email,
              role: user.role,
              status: user.status,
            })),
          url,
        ),
      });
    const groupMatch = /^\/api\/access\/groups\/([^/]+)(\/.*)?$/.exec(path);
    if (groupMatch) {
      const [, id, rest = ""] = groupMatch;
      const found = groups.get(id ?? "");
      if (!found || found.is_deleted)
        return route.fulfill({
          status: 404,
          json: { detail: "Group not found" },
        });
      if (rest === "" && method === "GET")
        return route.fulfill({ headers: { ETag: etag(found) }, json: found });
      if (request.headers()["if-match"] !== etag(found))
        return route.fulfill({
          status: 412,
          json: { detail: "Resource changed" },
        });
      if (rest === "" && method === "DELETE") {
        if (found.member_ids.length)
          return route.fulfill({
            status: 409,
            json: { detail: "Group has members" },
          });
        groups.set(found.id, {
          ...found,
          is_deleted: true,
          deleted_at: created,
          access: [],
        });
        return route.fulfill({ status: 204, body: "" });
      }
      const changes =
        rest === "" && method === "PATCH"
          ? (body as { name?: string; description?: string })
          : rest === "/members" && method === "PUT"
            ? { member_ids: (body as { member_ids: string[] }).member_ids }
            : rest === "/access" && method === "PUT"
              ? { access: (body as { access: AccessEntry[] }).access }
              : null;
      if (changes) {
        const next = { ...found, ...changes, revision: found.revision + 1 };
        groups.set(found.id, next);
        return route.fulfill({ headers: { ETag: etag(next) }, json: next });
      }
    }
    if (path === "/api/departments")
      return route.fulfill({ json: listPage(departments, url) });
    if (path === "/api/modules")
      return route.fulfill({ json: listPage(modules, url) });
    if (path === "/api/workspace" && method === "GET")
      return route.fulfill({ json: api.workspace });
    if (path === "/api/workspace" && method === "PATCH") {
      const input = body as Partial<Workspace>;
      if (input.revision !== api.workspace.revision)
        return route.fulfill({
          status: 409,
          json: {
            detail: {
              code: "stale_revision",
              message: "Workspace configuration has changed",
            },
          },
        });
      api.workspace = {
        ...api.workspace,
        ...input,
        revision: api.workspace.revision + 1,
      };
      return route.fulfill({ json: api.workspace });
    }
    if (path === "/api/auth/invitations" && method === "POST") {
      const input = body as Partial<User>;
      const invited = person({
        id: "00000000-0000-4000-8000-000000000199",
        username: String(input.username),
        email: String(input.email),
        role: input.role ?? "member",
        status: "pending",
      });
      users.set(invited.id, invited);
      return route.fulfill({
        status: 201,
        json: { user: invited, delivery: "email" },
      });
    }
    const userMatch = /^\/api\/users\/([^/]+)(\/.*)?$/.exec(path);
    if (userMatch) {
      const [, id, rest = ""] = userMatch;
      const user = users.get(id ?? "");
      if (!user)
        return route.fulfill({ status: 404, json: { detail: "Not found" } });
      if (rest === "" && method === "GET")
        return user.is_deleted
          ? route.fulfill({ status: 404, json: { detail: "User not found" } })
          : route.fulfill({ json: user });
      if (rest === "" && method === "PATCH") {
        const next = { ...user, ...(body as Partial<User>) };
        users.set(user.id, next);
        return route.fulfill({ json: next });
      }
      if (rest === "/access")
        return route.fulfill({
          json: access[user.id] ?? {
            user_id: user.id,
            role: user.role,
            unrestricted: false,
            entries: [],
          },
        });
      if (rest === "/sessions" && method === "GET")
        return route.fulfill({
          json: listPage(user.id === ids.ben ? sessions : [], url),
        });
      if (rest.startsWith("/sessions") && method === "DELETE")
        return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  return api;
}

export function etag(item: { id: string; revision: number }): string {
  return `"${item.id}:${item.revision}"`;
}
