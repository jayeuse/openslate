import { expect, test } from "@playwright/test";

import {
  accessNavigationFor,
  getWorkspaceLocation,
  getWorkspaceNavigation,
  isWorkspaceNavigationItemActive,
  currentNavigationKey,
} from "../../src/components/workspace-navigation";

function item(
  pathname: string,
  search: string,
  groupId: string,
  itemId: string,
) {
  const group = getWorkspaceNavigation(
    pathname,
    new URLSearchParams(search),
    "all",
  ).find((entry) => entry.id === groupId);
  return group?.items.find((entry) => entry.id === itemId);
}

test("active section selection uses stable IDs when rendered copy changes", () => {
  const boards = getWorkspaceNavigation(
    "/boards",
    new URLSearchParams("section=calendar"),
    "all",
  ).find((entry) => entry.id === "boards");
  const calendar = boards?.items.find((entry) => entry.id === "calendar");

  expect(boards).toBeDefined();
  expect(calendar).toBeDefined();

  const renamedGroup = { ...boards!, label: "Planning" };
  const renamedItem = { ...calendar!, label: "Schedule" };

  expect(
    isWorkspaceNavigationItemActive(
      renamedGroup.id,
      renamedItem.id,
      "/boards",
      new URLSearchParams("section=calendar"),
    ),
  ).toBe(true);
});

const departmentId = "00000000-0000-4000-8000-0000000000d1";
const moduleId = "00000000-0000-4000-8000-0000000000e1";

test("Access navigation follows the signed-in role and manage access", () => {
  expect(accessNavigationFor({ role: "admin", access: [] })).toBe("all");
  expect(
    accessNavigationFor({
      role: "member",
      access: [
        { departmentId, moduleId: null, level: "read" },
        { departmentId, moduleId, level: "manage" },
      ],
    }),
  ).toBe("groups");
  expect(
    accessNavigationFor({
      role: "member",
      access: [{ departmentId, moduleId: null, level: "write" }],
    }),
  ).toBe("none");
  expect(accessNavigationFor({ role: "member", access: [] })).toBe("none");
  // A guest never manages, even if an entry claims it.
  expect(
    accessNavigationFor({
      role: "guest",
      access: [{ departmentId, moduleId: null, level: "manage" }],
    }),
  ).toBe("none");
  // Unknown identity (loading or failed) fails closed.
  expect(accessNavigationFor(undefined)).toBe("none");
});

test("Access lists Overview, People, Groups and Security for administrators", () => {
  const access = getWorkspaceNavigation(
    "/access",
    new URLSearchParams("view=groups"),
    "all",
  ).find((entry) => entry.id === "access");

  expect(
    access?.items.map((entry) => [entry.id, entry.label, entry.href]),
  ).toEqual([
    ["overview", "Overview", "/access?view=overview"],
    ["people", "People", "/access?view=people"],
    ["groups", "Groups", "/access?view=groups"],
    ["security", "Security", "/access?view=security"],
  ]);
  expect(access?.href).toBe("/access?view=overview");
  expect(
    isWorkspaceNavigationItemActive(
      "access",
      "groups",
      "/access",
      new URLSearchParams("view=groups"),
    ),
  ).toBe(true);
});

test("a department manager sees only the Groups entry of Access", () => {
  const access = getWorkspaceNavigation(
    "/sandbox",
    new URLSearchParams(),
    "groups",
  ).find((entry) => entry.id === "access");

  expect(access?.items.map((entry) => [entry.id, entry.href])).toEqual([
    ["groups", "/access?view=groups"],
  ]);
  expect(access?.href).toBe("/access?view=groups");
  expect(
    getWorkspaceLocation(
      "/access",
      new URLSearchParams("view=overview"),
      "",
      "groups",
    ),
  ).toEqual({
    workspace: { label: "Access", href: "/access?view=groups" },
    section: "Groups",
  });
});

test("Access is absent from the navigation without administrator or manage access", () => {
  const groups = getWorkspaceNavigation(
    "/sandbox",
    new URLSearchParams(),
    "none",
  );

  expect(groups.map((group) => group.id)).not.toContain("access");
  expect(
    getWorkspaceLocation("/access", new URLSearchParams(), "", "none"),
  ).toBeNull();
});

test("retired Access views open the Access overview", () => {
  for (const retired of [
    "identities",
    "permissions",
    "roles",
    "rules",
    "simulator",
    "reviews",
  ]) {
    expect(
      isWorkspaceNavigationItemActive(
        "access",
        "overview",
        "/access",
        new URLSearchParams(`view=${retired}`),
      ),
      retired,
    ).toBe(true);
  }
});

test("Sandbox uses the simplified sections while legacy links still open the matching area", () => {
  const navigation = getWorkspaceNavigation(
    "/sandbox",
    new URLSearchParams("section=simulation"),
    "all",
  ).find((entry) => entry.id === "sandbox");

  expect(navigation?.items.map((entry) => [entry.id, entry.label])).toEqual([
    ["build", "Build"],
    ["triggers", "Triggers"],
    ["test", "Test"],
    ["history", "History"],
  ]);
  expect(
    isWorkspaceNavigationItemActive(
      "sandbox",
      "test",
      "/sandbox",
      new URLSearchParams("section=Preview"),
    ),
  ).toBe(true);
});

test("sidebar section links preserve the active board while changing its section", () => {
  const calendar = item(
    "/boards",
    "board=operations&section=overview",
    "boards",
    "calendar",
  );

  expect(calendar?.href).toBe("/boards?section=calendar&board=operations");
  expect(
    isWorkspaceNavigationItemActive(
      "boards",
      "calendar",
      "/boards",
      new URLSearchParams("board=operations&section=calendar"),
    ),
  ).toBe(true);
});

test("sidebar section links retain only each screen's relevant deep-link context", () => {
  expect(
    item("/access", "view=people&user=ana", "access", "people")?.href,
  ).toBe("/access?view=people&user=ana");
  expect(
    item("/access", "view=people&user=ana", "access", "groups")?.href,
  ).toBe("/access?view=groups");
  expect(
    item(
      "/openview",
      "section=dashboards&module=incidents&dashboard=weekly",
      "openview",
      "dashboards",
    )?.href,
  ).toBe("/openview?section=dashboards&module=incidents&dashboard=weekly");
  expect(
    item(
      "/openview",
      "section=dashboards&module=incidents&dashboard=weekly",
      "openview",
      "views",
    )?.href,
  ).toBe("/openview?section=views&module=incidents");
  expect(
    item("/sandbox", "rule=approval&inspect=orders", "sandbox", "triggers")
      ?.href,
  ).toBe("/sandbox?section=triggers&rule=approval&inspect=orders");
  expect(
    item("/platform", "file=contract.pdf", "platform", "files")?.href,
  ).toBe("/platform?section=files");
  expect(
    item("/platform", "file=contract.pdf", "platform", "search")?.href,
  ).toBe("/platform?section=search");
});

test("active parsing recognizes defaults and invalid section values without marking an arbitrary child", () => {
  expect(
    isWorkspaceNavigationItemActive(
      "sandbox",
      "build",
      "/sandbox",
      new URLSearchParams(),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "boards",
      "overview",
      "/boards",
      new URLSearchParams("section=unknown"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "openview",
      "views",
      "/openview",
      new URLSearchParams("section=unknown"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "access",
      "overview",
      "/access",
      new URLSearchParams("view=invalid"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "sandbox",
      "build",
      "/sandbox",
      new URLSearchParams("section=invalid&rule=approval"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "platform",
      "search",
      "/platform",
      new URLSearchParams("section=invalid&file=contract.pdf"),
    ),
  ).toBe(true);
});

test("Platform has no Account child and still highlights notifications with explicit section precedence", () => {
  expect(
    isWorkspaceNavigationItemActive(
      "platform",
      "account",
      "/platform",
      new URLSearchParams(),
      "#account",
    ),
  ).toBe(false);
  expect(
    isWorkspaceNavigationItemActive(
      "platform",
      "notifications",
      "/platform",
      new URLSearchParams(),
      "#notifications",
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "platform",
      "search",
      "/platform",
      new URLSearchParams("file=contract.pdf"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "platform",
      "search",
      "/platform",
      new URLSearchParams("section=search&file=contract.pdf"),
      "#account",
    ),
  ).toBe(true);
});

test("sidebar highlights the same section as Access, OpenView, and Sandbox deep links", () => {
  expect(
    isWorkspaceNavigationItemActive(
      "access",
      "people",
      "/access",
      new URLSearchParams("user=sample-eli"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "openview",
      "views",
      "/openview",
      new URLSearchParams("section=charts&record=sample-sr-1004"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "sandbox",
      "triggers",
      "/sandbox",
      new URLSearchParams("section=TRIGGER"),
    ),
  ).toBe(true);
});

test("every workspace lists its default section first", () => {
  for (const group of getWorkspaceNavigation(
    "/",
    new URLSearchParams(),
    "all",
  )) {
    expect(group.href, group.id).toBe(group.items[0]?.href);
  }
});

test("the workspace location names the open section and links its workspace", () => {
  expect(
    getWorkspaceLocation(
      "/sandbox",
      new URLSearchParams("section=history"),
      "",
      "all",
    ),
  ).toEqual({
    workspace: { label: "Sandbox", href: "/sandbox?section=build" },
    section: "History",
  });
  expect(
    getWorkspaceLocation(
      "/sandbox",
      new URLSearchParams("section=designer"),
      "",
      "all",
    )?.section,
  ).toBe("Build");
  expect(
    getWorkspaceLocation(
      "/platform",
      new URLSearchParams("file=sample-file"),
      "",
      "all",
    ),
  ).toEqual({
    workspace: { label: "Platform", href: "/platform?section=search" },
    section: "Search",
  });
  expect(
    getWorkspaceLocation("/comms", new URLSearchParams(), "", "all"),
  ).toBeNull();
});

test("every workspace describes what it holds in one short line", () => {
  const groups = getWorkspaceNavigation(
    "/sandbox",
    new URLSearchParams(),
    "all",
  );

  expect(groups.map((group) => [group.id, group.description])).toEqual([
    ["sandbox", "Design departments and records"],
    ["boards", "Team pages and events"],
    ["access", "Who can see and change what"],
    ["openview", "Browse records and reports"],
    ["manage", "Organization settings and audit"],
    ["platform", "Files, search, and import & export"],
  ]);
});

test("the current navigation key follows the route and its section", () => {
  const key = (path: string, search = "") =>
    currentNavigationKey(path, new URLSearchParams(search));
  expect(key("/sandbox", "section=history")).toBe("sandbox:history");
  expect(key("/sandbox")).toBe("sandbox:build");
  expect(key("/comms")).toBe("comms");
  expect(key("/settings/appearance")).toBe("profile");
  expect(key("/profile")).toBe("profile");
  expect(key("/login")).toBeNull();
});
