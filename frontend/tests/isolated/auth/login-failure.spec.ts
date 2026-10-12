import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import { signIn } from "../../../src/lib/auth-api";
import { loginFailureMessage } from "../../../src/lib/login-failure";
import { installFetch } from "../access/fixtures";

// A refused sign-in shows one message and never the server's detail. A 429
// names the wait in whole minutes (at least one) only when Retry-After is a
// whole number of seconds; any other value, or none, says "later". The http
// journey "login explains ${failure.label} without exposing account details"
// keeps one example of each class with its wire body: wrong credentials, a
// rate limit with a delay, unavailable, a blocked network and a network
// failure.

const privateDetail = {
  detail: {
    code: "login_failed",
    message: "Private account detail for owner@example.test",
  },
};

const rows: {
  name: string;
  status: number;
  retryAfter?: string;
  code?: string;
  parsedRetryAfter?: number;
  message: string;
}[] = [
  {
    name: "wrong credentials",
    status: 401,
    message: "That email or password is not right.",
  },
  {
    name: "a 401 with a network code is still wrong credentials",
    status: 401,
    code: "ip_not_allowed",
    message: "That email or password is not right.",
  },
  {
    name: "a delay of 75 seconds rounds up to 2 minutes",
    status: 429,
    retryAfter: "75",
    parsedRetryAfter: 75,
    message: "Too many attempts. Try again in 2 minutes.",
  },
  {
    name: "a delay of exactly 60 seconds is 1 minute",
    status: 429,
    retryAfter: "60",
    parsedRetryAfter: 60,
    message: "Too many attempts. Try again in 1 minute.",
  },
  {
    name: "a delay of 61 seconds rounds up to 2 minutes",
    status: 429,
    retryAfter: "61",
    parsedRetryAfter: 61,
    message: "Too many attempts. Try again in 2 minutes.",
  },
  {
    name: "a delay of 0 seconds still names 1 minute",
    status: 429,
    retryAfter: "0",
    parsedRetryAfter: 0,
    message: "Too many attempts. Try again in 1 minute.",
  },
  {
    name: "no delay",
    status: 429,
    message: "Too many attempts. Try again later.",
  },
  {
    name: "a delay that is not a number",
    status: 429,
    retryAfter: "invalid",
    message: "Too many attempts. Try again later.",
  },
  {
    name: "a negative delay",
    status: 429,
    retryAfter: "-10",
    message: "Too many attempts. Try again later.",
  },
  {
    name: "a fractional delay",
    status: 429,
    retryAfter: "1.5",
    message: "Too many attempts. Try again later.",
  },
  {
    name: "a delay given as a date",
    status: 429,
    retryAfter: "Wed, 14 Oct 2026 07:28:00 GMT",
    message: "Too many attempts. Try again later.",
  },
  {
    name: "a delay beyond the safe integers",
    status: 429,
    retryAfter: "9007199254740993",
    message: "Too many attempts. Try again later.",
  },
  {
    name: "unavailable sign-in",
    status: 503,
    message: "Sign-in is not available now. Try again later.",
  },
  {
    name: "a blocked network",
    status: 403,
    code: "ip_not_allowed",
    message:
      "Sign-in from this network is not allowed. Contact your administrator.",
  },
  {
    name: "another forbidden response",
    status: 403,
    code: "other_denial",
    message: "Unable to sign in. Check your connection and try again.",
  },
  {
    name: "a server error",
    status: 500,
    message: "Unable to sign in. Check your connection and try again.",
  },
];

for (const row of rows)
  test(`login failure: ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json(
        row.code
          ? { detail: { ...privateDetail.detail, code: row.code } }
          : privateDetail,
        {
          status: row.status,
          headers: row.retryAfter ? { "Retry-After": row.retryAfter } : {},
        },
      ),
    );
    try {
      const error = await signIn("owner@example.test", "secret").catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).retryAfter).toBe(row.parsedRetryAfter);
      expect(loginFailureMessage(error)).toBe(row.message);
    } finally {
      mock.restore();
    }
  });

test("login failure: a network failure asks to check the connection", async () => {
  const mock = installFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const error = await signIn("owner@example.test", "secret").catch(
      (caught: unknown) => caught,
    );
    expect(loginFailureMessage(error)).toBe(
      "Unable to sign in. Check your connection and try again.",
    );
  } finally {
    mock.restore();
  }
});

test("login failure: an object that only looks like a 401 is not wrong credentials", () => {
  expect(loginFailureMessage({ status: 401, retryAfter: 60 })).toBe(
    "Unable to sign in. Check your connection and try again.",
  );
});
