import { expect, test } from "@playwright/test";

import {
  consumeRecoveryToken,
  hasValidRecoveryPasswordLength,
  passwordsMatch,
  retainRecoveryToken,
} from "../../../src/lib/recovery-token";

test("takes a recovery token from the fragment and removes it immediately", () => {
  const calls: Array<[unknown, string, string]> = [];
  const token = consumeRecoveryToken(
    {
      hash: "#token_hash=opaque-recovery-token&type=recovery",
      pathname: "/auth/recovery",
      search: "",
    } as Location,
    {
      replaceState: (
        state: unknown,
        title: string,
        url: string | URL | null | undefined,
      ) => void calls.push([state, title, String(url)]),
    } as unknown as History,
  );

  expect(token).toBe("opaque-recovery-token");
  expect(calls).toEqual([[null, "", "/auth/recovery"]]);
});

for (const hash of [
  "#token_hash=recovery&type=invite",
  "#token_hash=first&token_hash=second&type=recovery",
  "#token_hash=recovery&type=recovery&type=recovery",
  "#token_hash=%ZZ&type=recovery",
]) {
  test(`rejects and clears a malformed recovery fragment: ${hash}`, () => {
    const calls: string[] = [];
    expect(
      consumeRecoveryToken(
        { hash, pathname: "/auth/recovery", search: "" } as Location,
        {
          replaceState: (
            _state: unknown,
            _title: string,
            url: string | URL | null | undefined,
          ) => calls.push(String(url)),
        } as unknown as History,
      ),
    ).toBeNull();
    expect(calls).toEqual(["/auth/recovery"]);
  });
}

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
