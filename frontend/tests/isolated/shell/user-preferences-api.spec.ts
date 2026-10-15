import { expect, test } from "@playwright/test";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  preferencesNeedSessionRecheck,
  readUserPreferences,
  saveUserPreferences,
} from "../../../src/lib/user-theme-preferences";
import { installFetch } from "../platform/fixtures";

// Account preferences are trusted only in their strict shape and only for the
// account that asked; a 401 or an owner mismatch asks the session check and
// never starts an auth refresh. The http journeys keep one example of each
// class with its exact wire body: "strict preferences refuse malformed shape
// ..." (one shape), "a identity read never applies and can be explicitly
// retried" and "a ${fault} save response triggers the existing session check
// and never applies or resubmits" (identity, denied, unauthorized).

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";

const regionalDefaults = {
  timezone: null,
  date_format: "organization",
  time_format: "organization",
  week_start: "organization",
  start_page: "automatic",
} as const;

const preference = (
  theme: unknown = "dark",
  appearance: unknown = {
    ...regionalDefaults,
    motion: "system",
    keyboard_shortcuts: true,
  },
) => ({ user_id: userA, theme, appearance });

test("a preference read asks for this account without a cache or an auth refresh", async () => {
  const mock = installFetch(() => Response.json(preference()));
  try {
    await readUserPreferences(userA);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/users/${userA}/preferences`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("preferences accept the strict shape with every regional value", async () => {
  const regional = {
    timezone: "Europe/London",
    date_format: "dmy",
    time_format: "24h",
    week_start: "sunday",
    start_page: "manage",
  };
  const mock = installFetch(() =>
    Response.json(
      preference("light", {
        motion: "reduce",
        keyboard_shortcuts: false,
        ...regional,
      }),
    ),
  );
  try {
    expect(await readUserPreferences(userA)).toEqual({
      user_id: userA,
      theme: "light",
      appearance: { motion: "reduce", keyboard_shortcuts: false, ...regional },
    });
  } finally {
    mock.restore();
  }
});

test("preferences without regional values read the organization defaults", async () => {
  const mock = installFetch(() =>
    Response.json(
      preference("system", { motion: "system", keyboard_shortcuts: true }),
    ),
  );
  try {
    expect(await readUserPreferences(userA)).toEqual({
      user_id: userA,
      theme: "system",
      appearance: {
        motion: "system",
        keyboard_shortcuts: true,
        ...regionalDefaults,
      },
    });
  } finally {
    mock.restore();
  }
});

// Each body came from the http loop "strict preferences refuse malformed
// shape ${JSON.stringify(malformed)}" or the malformed read ("sepia").
const malformed: { name: string; body: unknown }[] = [
  { name: "an unknown theme", body: preference("sepia") },
  { name: "a null appearance", body: preference("dark", null) },
  {
    name: "an unknown motion",
    body: preference("dark", { motion: "normal", keyboard_shortcuts: true }),
  },
  {
    name: "a text shortcut flag",
    body: preference("dark", { motion: "system", keyboard_shortcuts: "false" }),
  },
  {
    name: "a missing shortcut flag",
    body: preference("dark", { motion: "system" }),
  },
  {
    name: "an unknown appearance key",
    body: preference("dark", {
      motion: "system",
      keyboard_shortcuts: true,
      density: "compact",
    }),
  },
  {
    name: "an unknown top-level key",
    body: { ...preference("dark"), density: "compact" },
  },
  ...[
    { name: "a numeric timezone", invalid: { timezone: 42 } },
    { name: "an unknown date format", invalid: { date_format: "locale" } },
    { name: "a null time format", invalid: { time_format: null } },
    { name: "an unknown week start", invalid: { week_start: "tuesday" } },
    { name: "an unknown start page", invalid: { start_page: "profile" } },
  ].map(({ name, invalid }) => ({
    name,
    body: preference("dark", {
      motion: "system",
      keyboard_shortcuts: true,
      ...invalid,
    }),
  })),
];

for (const row of malformed)
  test(`preferences with ${row.name} are refused`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(readUserPreferences(userA)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("a preference read for another account is an owner mismatch", async () => {
  const mock = installFetch(() =>
    Response.json({ ...preference(), user_id: userB }),
  );
  try {
    const error = await readUserPreferences(userA).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "preferences_owner_mismatch",
    });
    expect(preferencesNeedSessionRecheck(error)).toBe(true);
  } finally {
    mock.restore();
  }
});

test("a preference save sends only its partial fields and refuses another account's reply", async () => {
  const mock = installFetch(() =>
    Response.json({ ...preference(), user_id: userB }),
  );
  try {
    const error = await saveUserPreferences(userA, { theme: "dark" }).catch(
      (caught: unknown) => caught,
    );
    expect(mock.requests[0]?.init?.method).toBe("PATCH");
    expect(mock.requests[0]?.init?.body).toBe('{"theme":"dark"}');
    expect(error).toMatchObject({
      status: 403,
      code: "preferences_owner_mismatch",
    });
  } finally {
    mock.restore();
  }
});

const refusals: {
  label: string;
  status: number;
  code?: string;
  recheck: boolean;
}[] = [
  { label: "401", status: 401, recheck: true },
  {
    label: "403 owner mismatch",
    status: 403,
    code: "preferences_owner_mismatch",
    recheck: true,
  },
  { label: "403", status: 403, recheck: false },
  { label: "503", status: 503, recheck: false },
];

for (const row of refusals)
  test(`a ${row.label} save reply ${row.recheck ? "asks" : "does not ask"} the session check and starts no auth refresh`, async () => {
    const mock = installFetch(() =>
      Response.json(
        {
          detail: row.code
            ? { code: row.code, message: "Private mismatch detail" }
            : "Private detail",
        },
        { status: row.status },
      ),
    );
    try {
      const error = await saveUserPreferences(userA, {
        appearance: { motion: "reduce" },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ status: row.status });
      expect(preferencesNeedSessionRecheck(error)).toBe(row.recheck);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("an error that only looks like an API error does not ask the session check", () => {
  expect(
    preferencesNeedSessionRecheck({
      status: 401,
      code: "preferences_owner_mismatch",
    }),
  ).toBe(false);
  expect(preferencesNeedSessionRecheck(new ApiContractError())).toBe(false);
});
