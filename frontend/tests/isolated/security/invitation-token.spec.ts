import { expect, test } from "@playwright/test";

import {
  consumeInvitationToken,
  retainInvitationToken,
} from "../../../src/lib/invitation-token";

// Taking and rejecting invitation links is owned by the action-link table in
// tests/isolated/auth/action-token.spec.ts.

test("keeps a captured token when React repeats the pure state updater", () => {
  const location = {
    hash: "#token_hash=opaque-invitation-token&type=invite",
    pathname: "/auth/setup",
    search: "",
  };
  const history = {
    replaceState: () => {
      location.hash = "";
    },
  };
  const captured = consumeInvitationToken(
    location as Location,
    history as unknown as History,
  );
  const first = retainInvitationToken(null, captured);
  const second = retainInvitationToken(null, captured);
  expect(first).toBe("opaque-invitation-token");
  expect(second).toBe("opaque-invitation-token");
  expect(retainInvitationToken(first, null)).toBe("opaque-invitation-token");
});
