import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import { listAccessUsers } from "../../../src/components/systems/access/state/api";
import { directoryUser, installFetch, pageOf, timestamp } from "./fixtures";

// A People directory row carries monitoring (session count, two-step status)
// and sign-in history. A page with one unsupported fact is refused whole, so
// the directory shows "People could not be loaded" instead of guessing. The
// http journey "malformed ${contract} stays unavailable and a fresh Retry
// returns supported facts" keeps the negative count with its exact body.

const created = "2026-01-10T09:00:00Z";

const accepted = [
  { name: "unknown monitoring and history", fields: {} },
  {
    name: "recorded monitoring and history",
    fields: {
      active_session_count: 2,
      mfa_verified_totp: false,
      mfa_observed_at: timestamp,
      last_sign_in_at: timestamp,
      last_active_at: timestamp,
    },
  },
];

const refused: { name: string; fields: Record<string, unknown> }[] = [
  {
    name: "a negative session count",
    fields: {
      mfa_verified_totp: false,
      mfa_observed_at: created,
      last_active_at: null,
      active_session_count: -1,
      last_sign_in_at: null,
    },
  },
  {
    name: "a sign-in time that is not an instant",
    fields: {
      mfa_verified_totp: false,
      mfa_observed_at: created,
      last_active_at: null,
      active_session_count: 2,
      last_sign_in_at: "not-an-instant",
    },
  },
  { name: "a fractional session count", fields: { active_session_count: 1.5 } },
  {
    name: "a missing session count",
    fields: { active_session_count: undefined },
  },
  {
    name: "a two-step status that is not a boolean",
    fields: { mfa_verified_totp: "yes" },
  },
  {
    name: "an observation time without an offset",
    fields: { mfa_observed_at: "2026-10-06T12:00:00" },
  },
  {
    name: "a last activity that is not an instant",
    fields: { last_active_at: "yesterday" },
  },
];

for (const row of accepted)
  test(`directory list accepts ${row.name}`, async () => {
    const item = { ...directoryUser, ...row.fields };
    const mock = installFetch(() => Response.json(pageOf([item])));
    try {
      const page = await listAccessUsers();
      expect(page.items).toEqual([item]);
    } finally {
      mock.restore();
    }
  });

for (const row of refused)
  test(`directory list refuses ${row.name}`, async () => {
    const item: Record<string, unknown> = { ...directoryUser, ...row.fields };
    for (const [key, value] of Object.entries(item))
      if (value === undefined) delete item[key];
    const mock = installFetch(() => Response.json(pageOf([item])));
    try {
      await expect(listAccessUsers()).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });
