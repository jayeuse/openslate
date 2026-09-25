import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

function componentSource(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0)
    throw new Error(`Unable to find ${start} through ${end}.`);
  return source.slice(startIndex, endIndex + end.length);
}

function disclosureSource(source: string, label: string): string {
  const labelIndex = source.indexOf(label);
  const startIndex = source.lastIndexOf("<details", labelIndex);
  const endIndex = source.indexOf("</details>", labelIndex);
  if (labelIndex < 0 || startIndex < 0 || endIndex < 0)
    throw new Error(`Unable to find the ${label} disclosure.`);
  return source.slice(startIndex, endIndex + "</details>".length);
}

test("overview cards give each destination a visible, wrapping-safe action", () => {
  const source = componentSource(
    "components/systems/access/components/overview-view.tsx",
  );
  const cards = sourceBetween(
    source,
    '<div className="grid grid-cols-1',
    "</section>",
  );

  expect(cards).toContain("grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4");
  expect(cards).toContain("Open {label}");
  expect(cards).toContain(
    'className="h-auto min-h-11 w-full justify-between whitespace-normal"',
  );
  expect(cards).toContain("onClick={() => onNavigate?.(destination)}");
  expect(source).toMatch(
    /Open Manage, then\s+Audit, to review recorded activity\./,
  );
});

test("identity directory keeps common controls visible and groups secondary settings", () => {
  const source = componentSource(
    "components/systems/access/components/identities-view.tsx",
  );
  const filterCard = sourceBetween(
    source,
    '<Card className="w-full" role="search" aria-label="Identity filters">',
    "      </Card>",
  );
  const moreFilters = disclosureSource(source, "More filters");
  const resetControl = sourceBetween(
    source,
    "{hasNonDefaultDirectorySettings && (",
    "</details>",
  );
  const resetBehavior = sourceBetween(
    source,
    "function resetFilters()",
    "function openIdentity",
  );
  const activeSettings = sourceBetween(
    source,
    "const activeDirectorySettingsCount = [",
    "const hasNonDefaultDirectorySettings",
  );
  const desktopAction = sourceBetween(
    source,
    'id: "actions",',
    "function resetFilters()",
  );

  expect(source).toContain("Search identities");
  expect(source).toContain("Status");
  expect(filterCard.match(/<details\b/g)).toHaveLength(1);
  expect(moreFilters).toContain("More filters");
  expect(moreFilters).toContain("<summary className=");
  expect(moreFilters).toContain("focus-visible:outline-2");
  expect(moreFilters).toContain("group-open:rotate-180");
  for (const controlId of [
    'id="identity-kind"',
    'id="identity-role-filter"',
    'id="identity-group-filter"',
    'id="identity-department-filter"',
    'id="identity-expiry-filter"',
    'id="identity-sort"',
    'id="identity-page-size"',
  ]) {
    expect(moreFilters).toContain(controlId);
  }
  expect(moreFilters).toContain("activeDirectorySettingsCount");
  for (const activeSetting of [
    'query !== ""',
    'kind !== "all"',
    'status !== "all"',
    'roleId !== "all"',
    'groupId !== "all"',
    'department !== "all"',
    'expiry !== "all"',
    'sort !== "name"',
    "pageSize !== PAGE_SIZE_OPTIONS[0]",
  ]) {
    expect(activeSettings).toContain(activeSetting);
  }
  expect(resetControl).toContain("Reset directory");
  expect(resetControl).toContain("onClick={resetFilters}");
  for (const reset of [
    'setQuery("")',
    'setKind("all")',
    'setStatus("all")',
    'setRoleId("all")',
    'setGroupId("all")',
    'setDepartment("all")',
    'setExpiry("all")',
    'setSort("name")',
    "setPageSize(PAGE_SIZE_OPTIONS[0])",
    "setPageIndex(0)",
  ]) {
    expect(resetBehavior).toContain(reset);
  }
  expect(filterCard).toContain("sm:grid-cols-2");
  expect(desktopAction).toContain("aria-label={`Manage ${row.original.name}`}");
  expect(desktopAction).toContain(
    ">\n              Manage\n            </Button>",
  );
  expect(source).toContain("Manage {identity.name}");
  expect(desktopAction).toContain(
    "onClick={() => openIdentity(row.original.id)}",
  );
  expect(source).toContain("onOpen={() => openIdentity(identity.id)}");
  expect(source).toMatch(
    /controller\.availability\.bulkIdentityUpdates\s+\? columns\s+: columns\.filter/,
  );
  expect(source).toContain(
    "controller.availability.bulkIdentityUpdates && selected.length > 0",
  );
  expect(source).toContain("{controller.availability.bulkIdentityUpdates ? (");
});

test("authoritative directory does not offer activity and unreachable status filters", () => {
  const source = componentSource(
    "components/systems/access/components/identities-view.tsx",
  );
  const moreFilters = disclosureSource(source, "More filters");
  const statusOptions = sourceBetween(
    source,
    'id="identity-status"',
    "</NativeSelect>",
  );

  expect(moreFilters).not.toContain('value="activity"');
  expect(moreFilters).not.toContain('id="identity-activity-filter"');
  expect(moreFilters).toContain('id="identity-expiry-filter"');
  expect(statusOptions).not.toContain('value="deleted"');
  expect(statusOptions).not.toContain('value="suspended"');
});

test("identity editor explains email delivery without promising silence", () => {
  const source = componentSource(
    "components/systems/access/components/identity-editor.tsx",
  );

  expect(source).toContain(
    "Saving sends an email invitation. Passwords are never shown here.",
  );
  expect(source).toContain(
    "Profile changes do not send credentials. Resending an invitation sends email.",
  );
  expect(source).toContain("disabled={Boolean(existing)}");
  expect(source).toContain("Email addresses cannot be changed here.");
  expect(source).toContain(
    "An email invitation will be sent. No password is shown here.",
  );
  expect(source).not.toContain(
    "No messages or credentials are sent from this editor.",
  );
});

test("revoked invitations can be resent while revoke stays pending-only", () => {
  const source = componentSource(
    "components/systems/access/components/identity-editor.tsx",
  );
  const identityHelpers = componentSource(
    "components/systems/access/helpers/identity-editor.ts",
  );

  expect(source).toContain('existing.status === "revoked"');
  expect(source).toContain('existing.status === "pending" && (');
  expect(source).not.toContain(
    'title="Invitation revocation is not available yet."',
  );
  expect(identityHelpers).toContain(
    "The existing invitation link and temporary password will stop working. The profile remains in Access and can be resent.",
  );
  expect(source).toContain('existing.status === "disabled" ? (');
  expect(source).toContain("Enable identity");
  expect(source).toContain(
    'controller.actions.setIdentityStatus(existing.id, "active")',
  );
  expect(source).toContain('existing.status === "active" ? (');
  expect(source).not.toContain(
    "controller.actions.restoreIdentity(existing.id)",
  );
  expect(source).toContain(
    "Invitation revoked. Resend it to issue a new link.",
  );
});

test("identity editor explains required relationships without disabled group controls", () => {
  const source = componentSource(
    "components/systems/access/components/identity-editor.tsx",
  );
  const membership = sourceBetween(
    source,
    '{draft.kind !== "service" && (',
    '{draft.kind === "guest" && (',
  );

  expect(source).toContain("id={`${nameId}-sponsor-help`}");
  expect(source).toContain("aria-describedby={`${nameId}-sponsor-help`}");
  expect(source).toContain("id={`${nameId}-owner-help`}");
  expect(source).toContain("aria-describedby={`${nameId}-owner-help`}");
  expect(source).toContain("A sponsor is required for guest access.");
  expect(source).toContain("An owner is required for service access.");
  expect(membership).toContain("draft.groupIds.length === 0");
  expect(membership).toContain("draft.groupIds.map((groupId)");
  expect(membership).toContain(
    "Groups tab. Choose a group and edit its members there.",
  );
  expect(membership).not.toContain("<Checkbox");
});

test("identity editor hides service sessions and removes only the no-op reset preview", () => {
  const source = componentSource(
    "components/systems/access/components/identity-editor.tsx",
  );

  expect(source).toContain('{existing && existing.kind !== "service" && (');
  expect(source).toContain("aria-labelledby={`${nameId}-sessions`}");
  expect(source).toContain("controller.actions.revokeSession(");
  expect(source).toContain("controller.actions.revokeAllSessions(");
  expect(source).not.toContain("Preview password reset");
  expect(source).not.toContain("Password reset preview");
  expect(source).not.toContain("resetPreview");
});
