import { expect, test } from "@playwright/test";

import {
  consumeRecoveryToken,
  hasValidRecoveryPasswordLength,
  passwordsMatch,
  retainRecoveryToken,
} from "../../../src/lib/recovery-token";

// Taking and rejecting recovery links is owned by the action-link table in
// tests/isolated/auth/action-token.spec.ts.

test("keeps a captured recovery token when StrictMode repeats the state updater", () => {
  const location = {
    hash: "#token_hash=opaque-recovery-token&type=recovery",
    pathname: "/auth/recovery",
    search: "",
  };
  const history = {
    replaceState: () => {
      location.hash = "";
    },
  };
  const captured = consumeRecoveryToken(
    location as Location,
    history as unknown as History,
  );

  expect(retainRecoveryToken(null, captured)).toBe("opaque-recovery-token");
  expect(retainRecoveryToken(null, captured)).toBe("opaque-recovery-token");
  expect(retainRecoveryToken(captured, null)).toBe("opaque-recovery-token");
});

test("rejects a mismatched password confirmation before recovery completion", () => {
  expect(passwordsMatch("a long enough password", "different password")).toBe(
    false,
  );
  expect(passwordsMatch("same password", "same password")).toBe(true);
});

test("blocks a recovery password longer than the backend maximum", () => {
  expect(hasValidRecoveryPasswordLength("a".repeat(11))).toBe(false);
  expect(hasValidRecoveryPasswordLength("a".repeat(12))).toBe(true);
  expect(hasValidRecoveryPasswordLength("a".repeat(128))).toBe(true);
  expect(hasValidRecoveryPasswordLength("a".repeat(129))).toBe(false);
});
