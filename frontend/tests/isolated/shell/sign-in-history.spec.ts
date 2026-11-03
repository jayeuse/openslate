import { expect, test } from "@playwright/test";

import { SignInHistoryView } from "../../../src/components/settings/components/sign-in-history";
import { signInEventWords } from "../../../src/components/settings/domain/sessions";
import {
  listOwnSignInEvents,
  type SignInEvent,
} from "../../../src/components/systems/platform/adapters/account-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import { staticMarkup } from "../sandbox/static-markup";

// Your sign-in history in Settings → Sessions (docs/specs/system-health.md,
// S4-C2 and D9): the read (API contract S4), the words of each row (D9.2)
// and the list states with "Show older" (D9.3, D9.4).

const chromeMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const region = { locale: "en-US", timezone: "America/New_York" };
const reference = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";

const event = (
  kind: SignInEvent["kind"],
  id: string,
  overrides: Partial<SignInEvent> = {},
): SignInEvent => ({
  id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
  kind,
  occurred_at: "2026-11-02T14:42:00Z",
  user_agent: chromeMac,
  ip_address: "10.0.4.21",
  ...overrides,
});

const page = (items: SignInEvent[], hasMore: boolean, offset = 0) => ({
  items,
  pagination: {
    limit: 10,
    offset,
    count: items.length,
    total: offset + items.length + (hasMore ? 1 : 0),
    has_more: hasMore,
  },
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("S4-C2: the history reads its own events ten at a time, newest first", async () => {
  const body = page([event("signed_in", "1")], true, 10);
  const fetchStub = installFetch(() => json(body));
  try {
    expect(await listOwnSignInEvents(10)).toEqual(body);
    expect(String(fetchStub.requests[0].input)).toBe(
      "/api/auth/sign-in-events?limit=10&offset=10",
    );
  } finally {
    fetchStub.restore();
  }
});

test("S4-C2: an event outside the contract is refused", async () => {
  for (const item of [
    { ...event("signed_in", "1"), subject_id: reference },
    { ...event("signed_in", "1"), kind: "idle_timeout" },
  ]) {
    const fetchStub = installFetch(() =>
      json(page([item as SignInEvent], false)),
    );
    try {
      await expect(listOwnSignInEvents(0)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      fetchStub.restore();
    }
  }
});

test("S4-C2: each event reads as a plain sentence with its device, address and time", () => {
  for (const [kind, sentence, tone] of [
    ["signed_in", "Signed in", "muted"],
    ["sign_in_failed", "Sign-in failed", "danger"],
    ["locked_out", "Sign-in paused after too many failed attempts", "warn"],
    // The contract names no ender, so every ended session reads the same.
    ["session_ended", "Session ended", "muted"],
  ] as const)
    expect(signInEventWords(event(kind, "7"), region), kind).toEqual({
      key: `${kind}:00000000-0000-4000-8000-000000000007`,
      kind,
      sentence,
      tone,
      device: "Chrome on macOS",
      userAgent: chromeMac,
      address: "10.0.4.21",
      time: "Nov 2, 2026, 9:42 AM",
    });
  expect(
    signInEventWords(
      event("sign_in_failed", "8", {
        user_agent: null,
        ip_address: null,
        occurred_at: "not a time",
      }),
      region,
    ),
  ).toMatchObject({
    device: "Unknown device",
    userAgent: null,
    address: "Unknown address",
    time: "Time unavailable",
  });
  expect(signInEventWords(event("signed_in", "9"), undefined).time).toBe(
    "Time unavailable",
  );
});

const words = (markup: string) => markup.replace(/ class="[^"]*"/g, "");

function history(props: Partial<Parameters<typeof SignInHistoryView>[0]>) {
  return words(
    staticMarkup(SignInHistoryView, {
      state: { kind: "loading" },
      timeState: "ready",
      focusKey: null,
      onRetry: () => {},
      onShowOlder: () => {},
      ...props,
    }),
  );
}

const rows = [
  signInEventWords(event("signed_in", "1"), region),
  signInEventWords(event("sign_in_failed", "2"), region),
];

test("S4-C2: the history has its heading, its line, and an ordered list without controls", () => {
  const markup = history({ state: { kind: "rows", rows, older: "none" } });
  expect(markup).toContain(">Your sign-in history</h3>");
  expect(markup).toContain(
    ">Sign-ins, failed attempts and ended sessions on your account, newest first. If you do not recognize one, change your password.</p>",
  );
  expect(markup).toContain('<ol aria-label="Your sign-in history">');
  const list = markup.slice(markup.indexOf("<ol"), markup.indexOf("</ol>"));
  expect(list).not.toMatch(/<button/);
  expect(list).toContain(">Signed in<");
  expect(list).toContain(">Sign-in failed<");
  expect(list).toContain(`<span title="${chromeMac}">Chrome on macOS</span>`);
  expect(list).toContain(">10.0.4.21<");
  expect(list).toContain(">Nov 2, 2026, 9:42 AM<");
  // Each row is a focus target for "Show older" (tabIndex -1), never a tab stop.
  expect(list.match(/<li tabindex="-1"/g)).toHaveLength(2);
  // No older events: no button.
  expect(markup).not.toContain("Show older");
});

test("S4-C2: Show older stays named and busy while a page loads, and is gone at the end", () => {
  const idle = history({ state: { kind: "rows", rows, older: "idle" } });
  expect(idle).toMatch(/<button[^>]*>Show older<\/button>/);
  const loading = history({ state: { kind: "rows", rows, older: "loading" } });
  const button = loading.match(/<button[^>]*>Show older<\/button>/)?.[0];
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain('aria-disabled="true"');
  expect(button).not.toContain('disabled=""');
});

test("S4-C2: a failed older page keeps the rows and offers Retry with the reference", () => {
  const markup = history({
    state: { kind: "rows", rows, older: { failed: reference } },
  });
  expect(markup).toContain(">Signed in<");
  expect(markup).toContain(">Older sign-in events could not be loaded.</p>");
  expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  expect(markup).toContain(">2e1a0b2c</code>");
  expect(markup).not.toContain("Show older");
});

test("S4-C2: the history says when it is empty, loading or failed", () => {
  expect(
    history({ state: { kind: "rows", rows: [], older: "none" } }),
  ).toContain(">No sign-in events are recorded yet.<");
  const loading = history({ state: { kind: "loading" } });
  expect(loading).toContain(">Your sign-in history</h3>");
  expect(loading).not.toContain("<ol");
  const failed = history({ state: { kind: "error", reference } });
  expect(failed).toContain(
    ">Sign-in history could not be loaded. Try again.</p>",
  );
  expect(failed).toMatch(/<button[^>]*>Retry sign-in history<\/button>/);
  expect(failed).toContain(">2e1a0b2c</code>");
  // While the organization's date settings load, the time says so.
  expect(
    history({
      state: { kind: "rows", rows, older: "none" },
      timeState: "loading",
    }),
  ).toContain(">Loading organization date settings…<");
});

test("S4-C2, D13 item 4: when the identity read fails, the history waits for the sessions with one line", () => {
  // The sessions block above shows the one error and its retry.
  const markup = history({ state: { kind: "waiting" } });
  expect(markup).toContain(">Your sign-in history</h3>");
  expect(markup).toContain(
    ">Your sign-in history shows when your sessions load.<",
  );
  expect(markup).not.toMatch(/<ol|Show older|role="alert"|Retry/);
  expect(markup).not.toContain("Loading sign-in history");
});
