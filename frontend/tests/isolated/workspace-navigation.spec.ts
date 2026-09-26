import { expect, test } from "@playwright/test";

import {
  getWorkspaceLocation,
  getWorkspaceNavigation,
  isWorkspaceNavigationItemActive,
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
  ).find((entry) => entry.id === groupId);
  return group?.items.find((entry) => entry.id === itemId);
}

test("active section selection uses stable IDs when rendered copy changes", () => {
  const boards = getWorkspaceNavigation(
    "/boards",
    new URLSearchParams("section=calendar"),
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

test("Access keeps one Permissions entry while legacy views highlight it", () => {
  const access = getWorkspaceNavigation(
    "/access",
    new URLSearchParams("view=permissions"),
  ).find((entry) => entry.id === "access");

  expect(
    access?.items.map((entry) => [entry.id, entry.label, entry.href]),
  ).toEqual([
    ["overview", "Overview", "/access?view=overview"],
    ["identities", "People & services", "/access?view=identities"],
    ["permissions", "Permissions", "/access?view=permissions"],
  ]);

  expect(
    isWorkspaceNavigationItemActive(
      "access",
      "permissions",
      "/access",
      new URLSearchParams("view=permissions"),
    ),
  ).toBe(true);
  for (const legacyView of ["roles", "groups", "rules"]) {
    expect(
      isWorkspaceNavigationItemActive(
        "access",
        "permissions",
        "/access",
        new URLSearchParams(`view=${legacyView}`),
      ),
    ).toBe(true);
  }
  expect(
    isWorkspaceNavigationItemActive(
      "access",
      "identities",
      "/access",
      new URLSearchParams("view=simulator"),
    ),
  ).toBe(true);
  expect(
    isWorkspaceNavigationItemActive(
      "access",
      "overview",
      "/access",
      new URLSearchParams("view=reviews"),
    ),
  ).toBe(true);
});

test("Sandbox uses the simplified sections while legacy links still open the matching area", () => {
  const navigation = getWorkspaceNavigation(
    "/sandbox",
    new URLSearchParams("section=simulation"),
  ).find((entry) => entry.id === "sandbox");

  expect(navigation?.items.map((entry) => [entry.id, entry.label])).toEqual([
    ["build", "Build"],
    ["automations", "Automations"],
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
    item("/access", "view=identities&user=ana", "access", "identities")?.href,
  ).toBe("/access?view=identities&user=ana");
  expect(
    item("/access", "view=identities&user=ana", "access", "permissions")?.href,
  ).toBe("/access?view=permissions");
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
    item("/sandbox", "rule=approval&inspect=orders", "sandbox", "automations")
      ?.href,
  ).toBe("/sandbox?section=automations&rule=approval&inspect=orders");
  expect(
    item("/platform", "file=contract.pdf", "platform", "files")?.href,
  ).toBe("/platform?section=files&file=contract.pdf");
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

test("Platform highlights legacy account and notification links until an explicit section takes precedence", () => {
  expect(
    isWorkspaceNavigationItemActive(
      "platform",
      "account",
      "/platform",
      new URLSearchParams(),
      "#account",
    ),
  ).toBe(true);
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
      "files",
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
      "identities",
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
      "automations",
      "/sandbox",
      new URLSearchParams("section=AUTOMATION"),
    ),
  ).toBe(true);
});

test("every workspace lists its default section first", () => {
  for (const group of getWorkspaceNavigation("/", new URLSearchParams())) {
    expect(group.href, group.id).toBe(group.items[0]?.href);
  }
});

test("the workspace location names the open section and links its workspace", () => {
  expect(
    getWorkspaceLocation("/sandbox", new URLSearchParams("section=history")),
  ).toEqual({
    workspace: { label: "Sandbox", href: "/sandbox?section=build" },
    section: "History",
  });
  expect(
    getWorkspaceLocation("/sandbox", new URLSearchParams("section=designer"))
      ?.section,
  ).toBe("Build");
  expect(
    getWorkspaceLocation("/platform", new URLSearchParams("file=sample-file")),
  ).toEqual({
    workspace: { label: "Platform", href: "/platform?section=search" },
    section: "File library",
  });
  expect(getWorkspaceLocation("/comms", new URLSearchParams())).toBeNull();
});
