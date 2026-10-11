import { expect, test } from "@playwright/test";

import { workspaceStartRoute } from "../../../src/components/workspace-start";
import { installFetch } from "../access/fixtures";

// Where a signed-in person lands when a start page is saved. The inputs are
// the bodies the sign-in journeys in tests/http/auth-sign-in-destination.spec.ts
// used: one published module, a Sandbox probe that answers or is refused, and a
// preference read for the signed-in account. The http spec keeps the first
// sign-in journeys, the admitted Sandbox row, one denied (403 probe), one
// unavailable (503 preference) and one other-owner example, and the held
// prior-account race.

const userId = "00000000-0000-4000-8000-000000000301";
const moduleId = "00000000-0000-4000-8000-000000000302";
const departmentId = "00000000-0000-4000-8000-000000000303";
const me = "GET /api/auth/me";
const preferences = `GET /api/users/${userId}/preferences`;
const probe = "GET /api/sandbox/tests?limit=1&offset=0";
const catalog = "GET /api/views/data-sources?limit=1&offset=0";

type Row = {
  name: string;
  role: "admin" | "member" | "guest";
  manages?: boolean;
  startPage: string;
  sandbox: "allowed" | "denied";
  preference?: { status: number; owner: string };
  expected: string;
  requests: string[];
};

const rows: Row[] = [
  {
    name: "preferred Boards opens Boards for a guest",
    role: "guest",
    startPage: "boards",
    sandbox: "allowed",
    expected: "/boards",
    requests: [me, preferences, me],
  },
  {
    name: "preferred Comms opens Comms for a guest",
    role: "guest",
    startPage: "comms",
    sandbox: "allowed",
    expected: "/comms",
    requests: [me, preferences, me],
  },
  {
    name: "preferred OpenView opens OpenView",
    role: "admin",
    startPage: "openview",
    sandbox: "allowed",
    expected: "/openview",
    requests: [me, preferences, me],
  },
  {
    name: "preferred Manage opens Manage for a guest",
    role: "guest",
    startPage: "manage",
    sandbox: "allowed",
    expected: "/manage",
    requests: [me, preferences, me],
  },
  {
    name: "preferred Platform opens Platform for a guest",
    role: "guest",
    startPage: "platform",
    sandbox: "allowed",
    expected: "/platform",
    requests: [me, preferences, me],
  },
  {
    name: "preferred Sandbox reads one Test run, then checks the account again",
    role: "admin",
    startPage: "sandbox",
    sandbox: "allowed",
    expected: "/sandbox",
    requests: [me, preferences, me, probe, me],
  },
  {
    name: "preferred Access opens administrator controls for an administrator",
    role: "admin",
    startPage: "access",
    sandbox: "allowed",
    expected: "/access",
    requests: [me, preferences, me],
  },
  {
    name: "preferred Access sends a member manager to Groups rather than administrator controls",
    role: "member",
    manages: true,
    startPage: "access",
    sandbox: "denied",
    expected: "/access?view=groups",
    requests: [me, preferences, me],
  },
  {
    name: "preferred Access hidden from a member falls back to OpenView",
    role: "member",
    startPage: "access",
    sandbox: "denied",
    expected: "/openview",
    requests: [me, preferences, me, catalog],
  },
  {
    name: "a preferred off-site URL falls back to OpenView",
    role: "member",
    startPage: "https://untrusted.example",
    sandbox: "denied",
    expected: "/openview",
    requests: [me, preferences, catalog],
  },
  {
    name: "preferred Sandbox refused by the probe falls back to OpenView",
    role: "member",
    startPage: "sandbox",
    sandbox: "denied",
    expected: "/openview",
    requests: [me, preferences, me, probe, catalog],
  },
  {
    name: "an unavailable preference read falls back to OpenView",
    role: "admin",
    startPage: "platform",
    sandbox: "allowed",
    preference: { status: 503, owner: userId },
    expected: "/openview",
    requests: [me, preferences, catalog],
  },
  {
    name: "a preference owned by another account falls back to OpenView",
    role: "admin",
    startPage: "platform",
    sandbox: "allowed",
    preference: { status: 200, owner: departmentId },
    expected: "/openview",
    requests: [me, preferences, catalog],
  },
];

for (const row of rows) {
  test(`workspace start: ${row.name}`, async () => {
    const mock = installFetch((input) => {
      const path = String(input);
      if (path === "/api/auth/me")
        return Response.json({
          id: userId,
          role: row.role,
          access: row.manages
            ? [
                {
                  department_id: departmentId,
                  module_id: null,
                  level: "manage",
                },
              ]
            : [],
        });
      if (path === `/api/users/${userId}/preferences`)
        return Response.json(
          {
            user_id: row.preference?.owner ?? userId,
            theme: "light",
            appearance: {
              motion: "system",
              keyboard_shortcuts: true,
              timezone: null,
              date_format: "organization",
              time_format: "organization",
              week_start: "organization",
              start_page: row.startPage,
            },
          },
          { status: row.preference?.status ?? 200 },
        );
      if (path.startsWith("/api/sandbox/tests?"))
        return row.sandbox === "allowed"
          ? Response.json({ items: [] })
          : Response.json({ detail: "Forbidden" }, { status: 403 });
      if (path.startsWith("/api/views/data-sources?"))
        return Response.json({
          items: [
            { id: moduleId, name: "Equipment", department_id: departmentId },
          ],
          pagination: {
            limit: 1,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    try {
      await expect(workspaceStartRoute()).resolves.toBe(row.expected);
      expect(
        mock.requests.map(
          ({ input, init }) => `${init?.method ?? "GET"} ${String(input)}`,
        ),
      ).toEqual(row.requests);
    } finally {
      mock.restore();
    }
  });
}
