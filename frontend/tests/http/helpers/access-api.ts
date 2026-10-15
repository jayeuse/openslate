import { expect, type Page, type Route } from "@playwright/test";
import { isEventStream } from "./test";
import { pageOf } from "../../helpers/pagination";

// A mocked Access API for the People, Groups and Overview HTTP specs. Every
// response matches the strict frontend contracts, and every list answers
// with requested server pages; complete catalog consumers still request 100. Groups
// carry an ETag ("<id>:<revision>") and refuse a stale If-Match with 412,
// like the backend.

export const DAY = 86_400_000;
export const at = (offset: number) =>
  new Date(Date.now() + offset).toISOString();
export const created = "2026-01-10T09:00:00Z";

/** A synthetic UUID whose last block is `index`, zero-padded. */
export const fixtureId = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

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
  department_name?: string;
  module_name?: string | null;
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
    access: access.map((entry) => ({
      ...entry,
      department_name:
        entry.department_name ??
        (entry.department_id === ids.inventory
          ? "Inventory"
          : entry.department_id === ids.finance
            ? "Finance"
            : "Unavailable department"),
      module_name:
        entry.module_name ?? (entry.module_id === ids.prices ? "Prices" : null),
    })),
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
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const slice = items.slice(offset, offset + limit);
  return pageOf(slice, { limit, offset, total: items.length });
}

export type Call = { method: string; path: string; body: unknown };
export type Handler = (
  route: Route,
  call: Call,
) => Promise<void | "next"> | void | "next";

export type MockOptions = {
  /** The signed-in person; an administrator by default. */
  identity?: { id: string; role: User["role"]; access: AccessEntry[] };
  /** A controlled API clock for cutoff and observation-metadata journeys. */
  now?: number;
};

export type Workspace = {
  invitation_expiry_days: number;
  guest_duration_days: number;
  revision: number;
  display_name: string;
};

export type Monitoring = {
  active_session_count: number;
  mfa_verified_totp: boolean | null;
  mfa_observed_at: string | null;
  last_sign_in_at?: string | null;
  last_active_at?: string | null;
};
export type Session = {
  id: string;
  created_at: string;
  refreshed_at: string;
  expires_at: string;
  user_agent: string | null;
  current: boolean;
  ip_address: string | null;
};
const unknownMonitoring: Monitoring = {
  active_session_count: 0,
  mfa_verified_totp: null,
  mfa_observed_at: null,
  last_sign_in_at: null,
  last_active_at: null,
};

export type Api = {
  monitoring: Map<string, Monitoring>;
  sessions: Session[];
  listReads: URLSearchParams[];
  summaryReads: number;
  summaryQueries: URLSearchParams[];
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
      title_field_id: null,
      ...catalogFields,
    },
  ];
  const sessions: Session[] = [
    {
      id: ids.laptop,
      created_at: created,
      refreshed_at: at(-DAY),
      expires_at: at(20 * DAY),
      user_agent: "Laptop browser",
      ip_address: "198.51.100.101",
      current: false,
    },
    {
      id: ids.phone,
      created_at: created,
      refreshed_at: at(-2 * DAY),
      expires_at: at(20 * DAY),
      user_agent: "Phone browser",
      ip_address: "2001:db8::102",
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
  const monitoring = new Map<string, Monitoring>([
    [
      ids.rosa,
      {
        active_session_count: 1,
        mfa_verified_totp: true,
        mfa_observed_at: created,
      },
    ],
    [
      ids.ben,
      {
        active_session_count: 2,
        mfa_verified_totp: false,
        mfa_observed_at: created,
      },
    ],
  ]);
  const calls: Call[] = [];
  const handlers = new Map<string, Handler>();
  const api: Api = {
    monitoring,
    sessions,
    listReads: [],
    summaryReads: 0,
    summaryQueries: [],
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
    if (isEventStream(route)) return route.fallback();
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
    if (method === "GET" && path === "/api/users")
      api.listReads.push(new URLSearchParams(url.searchParams));
    if (method === "GET" && path === "/api/users/summary") {
      api.summaryReads += 1;
      api.summaryQueries.push(new URLSearchParams(url.searchParams));
    }
    const override = handlers.get(`${method} ${path}`);
    if (override && (await override(route, call)) !== "next") return;

    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          authenticated: true,
          user_id: options.identity?.id ?? ids.rosa,
          default_organization_blocked: null,
          setup_required: false,
        },
      });
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          default_organization_blocked: null,
          ...(options.identity ?? { id: ids.rosa, role: "admin", access: [] }),
        },
      });
    const capturedAt = options.now ?? Date.now();
    const established = (user: User) =>
      !user.is_deleted &&
      user.status === "active" &&
      (!user.expires_at || Date.parse(user.expires_at) > capturedAt);
    const eligible = (user: User) => established(user) && user.role === "admin";
    const mfaMatches = (user: User, mode: string) =>
      eligible(user) &&
      (mode === "without"
        ? monitoring.get(user.id)?.mfa_verified_totp === false
        : monitoring.get(user.id)?.mfa_verified_totp == null);
    const inactiveDays = Number(url.searchParams.get("inactive_days") ?? 30);
    const historyMatches = (user: User, history: string) => {
      if (!established(user)) return false;
      const observation = monitoring.get(user.id) ?? unknownMonitoring;
      return history === "no-recorded-sign-in"
        ? observation.last_sign_in_at == null
        : observation.last_active_at != null &&
            Date.parse(observation.last_active_at) <
              capturedAt - inactiveDays * DAY;
    };
    if (path === "/api/users/summary" && method === "GET") {
      const all = [...users.values()];
      return route.fulfill({
        json: {
          admins_without_mfa: all.filter((user) => mfaMatches(user, "without"))
            .length,
          admins_mfa_unknown: all.filter((user) => mfaMatches(user, "unknown"))
            .length,
          no_recorded_sign_in: all.filter((user) =>
            historyMatches(user, "no-recorded-sign-in"),
          ).length,
          inactive_people: all.filter((user) =>
            historyMatches(user, "inactive"),
          ).length,
          as_of: new Date(capturedAt).toISOString(),
          inactive_days: inactiveDays,
        },
      });
    }
    if (path === "/api/users" && method === "GET") {
      const query = url.searchParams;
      const deleted = query.get("deleted") ?? "exclude";
      const role = query.get("role");
      const status = query.get("status");
      const mfa = query.get("mfa");
      const history = query.get("history");
      const groupId = query.get("group_id");
      const departmentId = query.get("department_id");
      const requestedIds = query.getAll("ids");
      const search = (query.get("search") ?? "").toLowerCase();
      const now = capturedAt;
      const activeGroups = [...groups.values()].filter(
        (group) => !group.is_deleted,
      );
      const matching = [...users.values()].filter((user) => {
        if (requestedIds.length && !requestedIds.includes(user.id))
          return false;
        if (
          (deleted === "exclude" && user.is_deleted) ||
          (deleted === "only" && !user.is_deleted) ||
          (role && user.role !== role)
        )
          return false;
        const expires = user.expires_at ? Date.parse(user.expires_at) : null;
        const expired = expires !== null && expires <= now;
        if (
          status === "expired"
            ? !expired
            : status === "ending"
              ? expires === null ||
                expired ||
                expires > now + 14 * DAY ||
                !["active", "pending"].includes(user.status)
              : status
                ? expired || user.status !== status
                : false
        )
          return false;
        if (mfa && !mfaMatches(user, mfa)) return false;
        if (history && !historyMatches(user, history)) return false;
        const memberOf =
          user.role === "admin"
            ? []
            : activeGroups.filter((group) =>
                group.member_ids.includes(user.id),
              );
        if (
          groupId === "none"
            ? user.role === "admin" || memberOf.length !== 0
            : groupId
              ? !memberOf.some((group) => group.id === groupId)
              : false
        )
          return false;
        if (
          departmentId &&
          !memberOf.some((group) =>
            group.access.some((entry) => entry.department_id === departmentId),
          )
        )
          return false;
        return (
          !search ||
          [
            user.display_name ?? "",
            user.username,
            user.email,
            user.job_title ?? "",
          ].some((value) => value.toLowerCase().includes(search))
        );
      });
      const sort = query.get("sort_by") ?? "username";
      const direction = query.get("sort_order") === "desc" ? -1 : 1;
      const name = (user: User) =>
        (user.display_name?.trim() || user.username).toLowerCase();
      matching.sort((left, right) => {
        if (
          sort === "expires_at" &&
          (left.expires_at === null || right.expires_at === null)
        )
          return left.expires_at === right.expires_at
            ? left.id.localeCompare(right.id)
            : left.expires_at === null
              ? 1
              : -1;
        const value = (user: User) =>
          sort === "name"
            ? name(user)
            : sort === "expires_at"
              ? (user.expires_at ?? "")
              : sort === "created_at"
                ? user.created_at
                : sort === "updated_at"
                  ? user.updated_at
                  : sort === "email"
                    ? user.email
                    : user.username;
        const primary = value(left).localeCompare(value(right));
        const tie =
          sort === "name" ? left.username.localeCompare(right.username) : 0;
        return (primary || tie) * direction || left.id.localeCompare(right.id);
      });
      return route.fulfill({
        json: listPage(
          matching.map((user) => {
            const observation = {
              ...unknownMonitoring,
              ...monitoring.get(user.id),
            };
            const active =
              !user.is_deleted &&
              user.status === "active" &&
              (!user.expires_at || Date.parse(user.expires_at) > capturedAt);
            return {
              ...user,
              ...observation,
              active_session_count: active
                ? observation.active_session_count
                : 0,
            };
          }),
          url,
        ),
      });
    }
    if (path === "/api/access/groups" && method === "GET") {
      const query = url.searchParams;
      const memberId = query.get("member_id");
      const needle = (query.get("search") ?? "").toLowerCase();
      const matching = [...groups.values()].filter(
        (item) =>
          !item.is_deleted &&
          (!memberId || item.member_ids.includes(memberId)) &&
          (query.get("without_access") !== "true" || !item.access.length) &&
          (query.get("without_members") !== "true" ||
            !item.member_ids.length) &&
          (!needle ||
            [
              item.name,
              item.description,
              ...item.access.flatMap((entry) => [
                entry.department_name ?? "",
                entry.module_name ?? "",
              ]),
            ].some((name) => name.toLowerCase().includes(needle))),
      );
      const direction = query.get("sort_order") === "desc" ? -1 : 1;
      matching.sort(
        (left, right) =>
          direction *
            (query.get("sort_by") === "member_count"
              ? left.member_ids.length - right.member_ids.length
              : query.get("sort_by") === "created_at"
                ? left.created_at.localeCompare(right.created_at)
                : left.name.localeCompare(right.name)) ||
          left.id.localeCompare(right.id),
      );
      return route.fulfill({ json: listPage(matching, url) });
    }
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
            .filter(
              (user) =>
                user.role !== "admin" &&
                !user.is_deleted &&
                (!url.searchParams.getAll("ids").length ||
                  url.searchParams.getAll("ids").includes(user.id)) &&
                (!(url.searchParams.get("search") ?? "") ||
                  [user.display_name ?? "", user.username, user.email].some(
                    (value) =>
                      value
                        .toLowerCase()
                        .includes(
                          (url.searchParams.get("search") ?? "").toLowerCase(),
                        ),
                  )),
            )
            .map((user) => ({
              id: user.id,
              display_name: user.display_name,
              username: user.username,
              email: user.email,
              role: user.role,
              status: user.status,
              access_ends_at: user.expires_at,
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
              ? {
                  access: group(
                    found.id,
                    found.name,
                    found.member_ids,
                    (body as { access: AccessEntry[] }).access,
                  ).access,
                }
              : null;
      if (changes) {
        const next = { ...found, ...changes, revision: found.revision + 1 };
        groups.set(found.id, next);
        return route.fulfill({ headers: { ETag: etag(next) }, json: next });
      }
    }
    if (path.startsWith("/api/departments/")) {
      const found = departments.find((item) => item.id === path.split("/")[3]);
      return found
        ? route.fulfill({ json: found })
        : route.fulfill({ status: 404, json: { detail: "Not found" } });
    }
    if (path === "/api/departments")
      return route.fulfill({
        json: listPage(
          departments.filter((item) =>
            item.department_name
              .toLowerCase()
              .includes((url.searchParams.get("search") ?? "").toLowerCase()),
          ),
          url,
        ),
      });
    if (path.startsWith("/api/modules/")) {
      const found = modules.find((item) => item.id === path.split("/")[3]);
      return found
        ? route.fulfill({ json: found })
        : route.fulfill({ status: 404, json: { detail: "Not found" } });
    }
    if (path === "/api/modules")
      return route.fulfill({
        json: listPage(
          modules.filter(
            (item) =>
              (!url.searchParams.get("department_id") ||
                item.department_id === url.searchParams.get("department_id")) &&
              item.module_name
                .toLowerCase()
                .includes((url.searchParams.get("search") ?? "").toLowerCase()),
          ),
          url,
        ),
      });
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
    const reconcile = /^\/api\/auth\/invitations\/([^/]+)\/reconcile$/.exec(
      path,
    );
    if (reconcile && method === "POST") {
      const user = users.get(reconcile[1]);
      if (
        !user ||
        user.is_deleted ||
        user.status !== "pending" ||
        user.invitation_sent_at !== null
      )
        return route.fulfill({
          status: 409,
          json: { detail: "Invitation unavailable" },
        });
      const sent = { ...user, invitation_sent_at: at(0), updated_at: at(0) };
      users.set(user.id, sent);
      return route.fulfill({ json: sent });
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
      if (rest === "/restore" && method === "POST") {
        const restored = {
          ...user,
          is_deleted: false,
          deleted_at: null,
          updated_at: at(0),
        };
        users.set(user.id, restored);
        return route.fulfill({ json: restored });
      }
      if (rest === "" && method === "PATCH") {
        const next = { ...user, ...(body as Partial<User>) };
        users.set(user.id, next);
        if (next.status === "disabled") {
          monitoring.set(user.id, {
            ...(monitoring.get(user.id) ?? unknownMonitoring),
            active_session_count: 0,
          });
          if (user.id === ids.ben) sessions.splice(0);
        }
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
      if (rest.startsWith("/sessions") && method === "DELETE") {
        const target = rest.split("/")[2];
        if (user.id === ids.ben) {
          for (let index = sessions.length - 1; index >= 0; index -= 1)
            if (
              !sessions[index].current &&
              (!target || sessions[index].id === target)
            )
              sessions.splice(index, 1);
          monitoring.set(user.id, {
            ...(monitoring.get(user.id) ?? unknownMonitoring),
            active_session_count: sessions.length,
          });
        }
        return route.fulfill({ status: 204, body: "" });
      }
    }
    return route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  return api;
}

export function etag(item: { id: string; revision: number }): string {
  return `"${item.id}:${item.revision}"`;
}

/**
 * Adds `count` members after the first page: IDs `fixtureId(start + n)`,
 * usernames `later000`, `later001`, ... and names `Later 000`, ...
 */
export function addPeople(api: Api, count: number, start: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = fixtureId(start + index);
    const suffix = String(index).padStart(3, "0");
    api.users.set(
      id,
      person({
        id,
        username: `later${suffix}`,
        display_name: `Later ${suffix}`,
      }),
    );
  }
}

/** The journey sent no create, update or delete request to the Access API. */
export function expectNoWrites(api: Api): void {
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
}
