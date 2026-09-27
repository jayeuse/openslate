import { expect, test } from "@playwright/test";

import {
  consumeInvitationToken,
  retainInvitationToken,
} from "../../../src/lib/invitation-token";

test("takes an invitation token from the URL fragment and removes it immediately", () => {
  const calls: Array<[unknown, string, string]> = [];
  const token = consumeInvitationToken(
    {
      hash: "#token_hash=opaque-invitation-token&type=invite",
      pathname: "/auth/setup",
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
  expect(token).toBe("opaque-invitation-token");
  expect(calls).toEqual([[null, "", "/auth/setup"]]);
});

test("does not treat query or unrelated fragment content as an invitation token", () => {
  const replaceState = () => {
    throw new Error("history must remain unchanged");
  };
  expect(
    consumeInvitationToken(
      { hash: "", pathname: "/auth/setup", search: "" } as Location,
      { replaceState } as unknown as History,
    ),
  ).toBeNull();
});

for (const hash of [
  "#token_hash=invite&type=recovery",
  "#token_hash=first&token_hash=second&type=invite",
  "#token_hash=invite&type=invite&type=invite",
  "#token_hash=&type=invite",
  "#token_hash=%ZZ&type=invite",
  "#token=legacy&type=invite",
]) {
  test(`rejects and clears a malformed invitation fragment: ${hash}`, () => {
    const calls: string[] = [];
    expect(
      consumeInvitationToken(
        {
          hash,
          pathname: "/auth/setup",
          search: "?token_hash=query-secret",
        } as Location,
        {
          replaceState: (
            _state: unknown,
            _title: string,
            url: string | URL | null | undefined,
          ) => calls.push(String(url)),
        } as unknown as History,
      ),
    ).toBeNull();
    expect(calls).toEqual(["/auth/setup"]);
  });
}

test("never accepts a query-string invitation credential", () => {
  const calls: string[] = [];
  expect(
    consumeInvitationToken(
      {
        hash: "",
        pathname: "/auth/setup",
        search: "?token_hash=query-secret&type=invite",
      } as Location,
      {
        replaceState: (
          _state: unknown,
          _title: string,
          url: string | URL | null | undefined,
        ) => calls.push(String(url)),
      } as unknown as History,
    ),
  ).toBeNull();
  expect(calls).toEqual(["/auth/setup"]);
});

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
