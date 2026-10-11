import { expect, test } from "@playwright/test";

import { consumeActionToken } from "../../../src/lib/action-token";
import { consumeInvitationToken } from "../../../src/lib/invitation-token";
import { consumeRecoveryToken } from "../../../src/lib/recovery-token";

// One-time action links (invitation, recovery, email change) carry their
// credential in the URL fragment. The page takes it once and removes it from
// history at once, even when the link is malformed. Invitation and recovery go
// through their page wrappers; the email change page calls consumeActionToken.
// The http specs keep one link per page: auth-setup.spec.ts (invitation and
// recovery fragments) and auth-email-change.spec.ts (a malformed email link).

const emailProof = "c".repeat(56);
const otherEmailProof = "d".repeat(56);

const pages = {
  invite: {
    pathname: "/auth/setup",
    consume: consumeInvitationToken,
  },
  recovery: {
    pathname: "/auth/recovery",
    consume: consumeRecoveryToken,
  },
  email_change: {
    pathname: "/auth/email-change",
    consume: (
      location: Pick<Location, "hash" | "pathname" | "search">,
      history: Pick<History, "replaceState">,
    ) => consumeActionToken(location, history, "email_change"),
  },
} as const;

type Row = {
  type: keyof typeof pages;
  name: string;
  hash: string;
  search?: string;
  token: string | null;
  /** Whether the page removes the fragment and query from history. */
  scrubbed: boolean;
};

const rows: Row[] = [
  {
    type: "invite",
    name: "takes the token from the fragment",
    hash: "#token_hash=opaque-invitation-token&type=invite",
    token: "opaque-invitation-token",
    scrubbed: true,
  },
  {
    type: "invite",
    name: "a page with no fragment or query",
    hash: "",
    token: null,
    scrubbed: false,
  },
  {
    type: "invite",
    name: "a query-string credential",
    hash: "",
    search: "?token_hash=query-secret&type=invite",
    token: null,
    scrubbed: true,
  },
  ...[
    "#token_hash=invite&type=recovery",
    "#token_hash=first&token_hash=second&type=invite",
    "#token_hash=invite&type=invite&type=invite",
    "#token_hash=&type=invite",
    "#token_hash=%ZZ&type=invite",
    "#token=legacy&type=invite",
    "#token_hash=extra&type=invite&next=%2Fadmin",
    "#token_hash=two+words&type=invite",
  ].map((hash) => ({
    type: "invite" as const,
    name: `a malformed fragment ${hash}`,
    hash,
    search: "?token_hash=query-secret",
    token: null,
    scrubbed: true,
  })),
  {
    type: "recovery",
    name: "takes the token from the fragment",
    hash: "#token_hash=opaque-recovery-token&type=recovery",
    token: "opaque-recovery-token",
    scrubbed: true,
  },
  ...[
    "#token_hash=recovery&type=invite",
    "#token_hash=first&token_hash=second&type=recovery",
    "#token_hash=recovery&type=recovery&type=recovery",
    "#token_hash=%ZZ&type=recovery",
  ].map((hash) => ({
    type: "recovery" as const,
    name: `a malformed fragment ${hash}`,
    hash,
    token: null,
    scrubbed: true,
  })),
  {
    type: "email_change",
    name: "takes a 56-character provider hash from the fragment",
    hash: `#token_hash=${emailProof}&type=email_change`,
    token: emailProof,
    scrubbed: true,
  },
  {
    type: "email_change",
    name: "a missing link",
    hash: "",
    token: null,
    scrubbed: false,
  },
  ...[
    `#token_hash=${emailProof}&type=recovery`,
    `#token_hash=${emailProof}&token_hash=${otherEmailProof}&type=email_change`,
    "#token_hash=not-a-provider-hash&type=email_change",
    `#token_hash=${"c".repeat(55)}&type=email_change`,
    `#token_hash=${"C".repeat(56)}&type=email_change`,
  ].map((hash) => ({
    type: "email_change" as const,
    name: `a malformed fragment ${hash}`,
    hash,
    token: null,
    scrubbed: true,
  })),
];

for (const row of rows) {
  test(`${row.type} link: ${row.name}`, () => {
    const { pathname, consume } = pages[row.type];
    const calls: Array<[unknown, string, string]> = [];
    const token = consume(
      { hash: row.hash, pathname, search: row.search ?? "" },
      {
        replaceState: (
          state: unknown,
          title: string,
          url?: string | URL | null,
        ) => void calls.push([state, title, String(url)]),
      },
    );
    expect(token).toBe(row.token);
    expect(calls).toEqual(row.scrubbed ? [[null, "", pathname]] : []);
  });
}
