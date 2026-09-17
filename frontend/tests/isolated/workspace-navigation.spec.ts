import { expect, test } from "@playwright/test";

import {
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
    item("/access", "view=identities&user=ana", "access", "roles")?.href,
  ).toBe("/access?view=roles");
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
    item("/sandbox", "rule=approval&inspect=orders", "sandbox", "automation")
      ?.href,
  ).toBe("/sandbox?section=automation&rule=approval&inspect=orders");
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
      "designer",
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
      "designer",
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
      "designer",
      "/sandbox",
      new URLSearchParams("section=AUTOMATION"),
    ),
  ).toBe(true);
});
