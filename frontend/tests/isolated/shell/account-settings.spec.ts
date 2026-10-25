import { expect, test } from "@playwright/test";

import {
  changedFields,
  identityPatch,
  savedDraft,
} from "../../../src/components/settings/domain/identity-draft";
import {
  ORGANIZATION_TIMEZONE,
  personalTimezoneOptions,
} from "../../../src/components/settings/domain/regional";
import {
  endSessionTitle,
  sessionRowWords,
} from "../../../src/components/settings/domain/sessions";
import { startPageOptions } from "../../../src/components/settings/domain/start-page";
import { twoStepWord } from "../../../src/components/settings/domain/two-step";
import type { ProfileSelf } from "../../../src/components/profile/adapters/profile-api";
import type { MfaStatus } from "../../../src/lib/mfa-api";

// Account settings rules (docs/specs/profile-sidebar-relayout.md, PD10-PD11):
// the Identity draft and its unsaved count, the personal timezone options,
// the words of a session row, and the two-step status word. The http journeys
// in tests/http/account-settings.spec.ts render one example of each.

const userA = "00000000-0000-4000-8000-000000000001";
const self: Pick<ProfileSelf, "display_name" | "job_title" | "phone" | "bio"> =
  {
    display_name: "Maya Chen",
    job_title: "Equipment coordinator",
    phone: "+1 555 0101",
    bio: null,
  };

test("the Identity draft counts only fields that differ from the saved profile and clears emptied ones", () => {
  const saved = savedDraft(self);
  expect(saved).toEqual({
    display_name: "Maya Chen",
    job_title: "Equipment coordinator",
    phone: "+1 555 0101",
    bio: "",
  });
  expect(changedFields(null, self)).toEqual([]);
  // A field typed back to its saved value is not a change.
  expect(changedFields({ ...saved, phone: "+1 555 0101" }, self)).toEqual([]);
  const draft = { ...saved, job_title: "Operations lead", phone: "" };
  expect(changedFields(draft, self)).toEqual(["job_title", "phone"]);
  expect(identityPatch(draft, self)).toEqual({
    job_title: "Operations lead",
    phone: null,
  });
  // A profile that has not loaded has no draft to count.
  expect(changedFields(draft, undefined)).toEqual([]);
});

test("personal timezone options list the organization timezone first, then each zone with its offset", () => {
  const reference = new Date("2026-01-15T00:00:00Z");
  const options = personalTimezoneOptions("Asia/Manila", null, reference);
  expect(options[0]).toEqual({
    value: ORGANIZATION_TIMEZONE,
    label: "Organization timezone (Asia/Manila)",
  });
  expect(options).toContainEqual({
    value: "America/Los_Angeles",
    label: "UTC-08:00 · America/Los Angeles",
  });
  expect(options).toContainEqual({
    value: "UTC",
    label: "UTC+00:00 · UTC",
  });
  expect(options.filter(({ value }) => value === "UTC")).toHaveLength(1);
  // Without an organization the first option names no zone, and a saved zone
  // that the browser does not list stays choosable.
  const unbound = personalTimezoneOptions(null, "Etc/GMT+8", reference);
  expect(unbound[0]).toEqual({
    value: ORGANIZATION_TIMEZONE,
    label: "Organization timezone",
  });
  expect(unbound.filter(({ value }) => value === "Etc/GMT+8")).toHaveLength(1);
});

test("a session row names the device, the address, this device, and its last activity", () => {
  const region = { timezone: "Asia/Manila", locale: "en-US" };
  const session = {
    id: "00000000-0000-4000-8000-000000000801",
    created_at: "2026-10-01T00:30:00Z",
    refreshed_at: "2026-10-24T09:47:00Z",
    expires_at: "2099-10-01T00:00:00Z",
    user_agent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    ip_address: "10.0.4.21",
    current: false,
  };
  expect(sessionRowWords(session, region)).toEqual({
    device: "Chrome on Windows",
    address: "10.0.4.21",
    here: false,
    active: "Oct 24, 2026, 5:47 PM",
    actionsLabel: "Session actions, Chrome on Windows",
    endLabel: "End session, Chrome on Windows",
  });
  const current = sessionRowWords(
    {
      ...session,
      user_agent: null,
      ip_address: null,
      current: true,
      refreshed_at: "not a time",
    },
    undefined,
  );
  expect(current).toEqual({
    device: "Unknown device",
    address: null,
    here: true,
    active: "Time unavailable",
    actionsLabel: "Session actions, Unknown device, this device",
    endLabel: "End session, Unknown device, this device",
  });
});

test("the two-step status word is On only for a verified authenticator", () => {
  const status = (
    factors: MfaStatus["factors"],
    policy = false,
  ): MfaStatus => ({
    user_id: userA,
    assurance_level: "aal1",
    required: false,
    policy_required: policy,
    required_since: null,
    enrollment_deadline: null,
    factors,
  });
  const factor = (state: "verified" | "unverified") => ({
    id: "00000000-0000-4000-8000-000000000601",
    factor_type: "totp",
    status: state,
  });
  expect(twoStepWord(status([factor("verified")]))).toEqual({
    word: "On",
    tone: "flow",
  });
  expect(twoStepWord(status([factor("unverified")]))).toEqual({
    word: "Off",
    tone: "muted",
  });
  // Off while the organization requires it is a warning, in words too.
  expect(twoStepWord(status([], true))).toEqual({
    word: "Off, required",
    tone: "warn",
  });
  // A failed read is a warning, not a quiet Off.
  expect(twoStepWord(null)).toEqual({ word: "Unavailable", tone: "warn" });
});

test("the end-session confirmation names the device it signs out", () => {
  expect(
    endSessionTitle(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    ),
  ).toBe("End the session on Safari, macOS?");
  expect(endSessionTitle(null)).toBe("End the session on an unknown device?");
});

// Start page lists the sections the sidebar shows this person (PD62): only
// the Sandbox (administrators) and Access (administrators and managers) are
// gated. A saved section the person can no longer open stays readable.
const startPageRows = [
  {
    name: "an administrator sees every section",
    access: "all",
    saved: "automatic",
    options: [
      "Automatic",
      "Sandbox",
      "Boards",
      "OpenComms",
      "Access",
      "OpenView",
      "Manage",
      "Platform",
    ],
    disabled: [],
  },
  {
    name: "a manager sees Access but not the Sandbox",
    access: "groups",
    saved: "boards",
    options: [
      "Automatic",
      "Boards",
      "OpenComms",
      "Access",
      "OpenView",
      "Manage",
      "Platform",
    ],
    disabled: [],
  },
  {
    name: "a reader or a guest sees neither the Sandbox nor Access",
    access: "none",
    saved: undefined,
    options: [
      "Automatic",
      "Boards",
      "OpenComms",
      "OpenView",
      "Manage",
      "Platform",
    ],
    disabled: [],
  },
  {
    name: "a saved section that is now hidden stays, marked and not choosable",
    access: "none",
    saved: "access",
    options: [
      "Automatic",
      "Boards",
      "OpenComms",
      "Access (not available)",
      "OpenView",
      "Manage",
      "Platform",
    ],
    disabled: ["Access (not available)"],
  },
] as const;
for (const row of startPageRows)
  test(`Start page: ${row.name}`, () => {
    const options = startPageOptions(row.access, row.saved);
    expect(options.map((option) => option.label)).toEqual(row.options);
    expect(
      options.filter((option) => option.disabled).map(({ label }) => label),
    ).toEqual(row.disabled);
  });
