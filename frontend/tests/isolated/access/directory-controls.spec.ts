import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { initialAccessIdentities } from "@/components/systems/access/domain/policy";
import { reviewedActionImpact } from "@/components/systems/access/helpers/identity-editor";

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

  expect(source).toContain('existing.status === "revoked"');
  expect(source).toContain('existing.status === "pending" && (');
  expect(source).not.toContain(
    'title="Invitation revocation is not available yet."',
  );
  const identity = initialAccessIdentities[0];
  if (!identity) throw new Error("Identity fixture is missing");
  const impact = reviewedActionImpact({ type: "revoke-invite", identity });
  expect(impact).toContain("no longer grant access");
  expect(impact).not.toContain("password");
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
    "Permissions. Choose a group, then Manage members.",
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
