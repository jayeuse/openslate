import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import {
  isStaleWorkspaceRevision,
  organizationLocaleLabel,
  organizationLocaleTag,
  workspaceSettingsFormFields,
  workspaceSettingsPatch,
  type ManageWorkspaceProfile,
} from "../../../src/components/systems/manage/adapters/workspace-api";
import { activeCurrencies } from "../../../src/components/systems/manage/state/currency-options";

// Organization settings rules: the form fields read from a saved profile, the
// patch a draft produces, the regional-format names and tags, the offered
// currencies, and the stale-revision signal. The http journeys keep one save
// per field group with its exact PATCH body ("Manage organization loads and
// saves all seven workspace fields", "regional choices search names and save
// stable format, zone and currency values").

const fullProfile: ManageWorkspaceProfile = {
  id: "00000000-0000-4000-8000-000000000077",
  display_name: "Riverside Services",
  legal_name: null,
  description: "Field services",
  logo_file_id: null,
  locale: "en-PH",
  timezone: "Asia/Manila",
  mark: "RS",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate",
  revision: 4,
  contact_email: "office@example.com",
  contact_phone: null,
  postal_address: null,
};

const guestProfile: ManageWorkspaceProfile = {
  id: "00000000-0000-4000-8000-000000000077",
  display_name: "Riverside Services",
  legal_name: "Riverside Services Ltd",
  description: null,
  logo_file_id: null,
  locale: "en-PH",
  timezone: "Asia/Manila",
  mark: "RS",
  currency: "PHP",
  week_start: "sunday",
  business_hours: "09:00–18:00",
  theme: "whiteboard",
  revision: 2,
};

test("the form reads every saved field and empty profile text", () => {
  expect(workspaceSettingsFormFields(fullProfile)).toEqual({
    name: "Riverside Services",
    locale: "en-PH",
    timezone: "Asia/Manila",
    logo: "RS",
    currency: "PHP",
    week: "Monday",
    hours: "09:00–18:00",
    theme: "slate",
    legalName: "",
    description: "Field services",
    contactEmail: "office@example.com",
    contactPhone: "",
    postalAddress: "",
  });
});

test("the form for a profile without contacts has no contact fields", () => {
  expect(workspaceSettingsFormFields(guestProfile)).toEqual({
    name: "Riverside Services",
    locale: "en-PH",
    timezone: "Asia/Manila",
    logo: "RS",
    currency: "PHP",
    week: "Sunday",
    hours: "09:00–18:00",
    theme: "whiteboard",
    legalName: "Riverside Services Ltd",
    description: "",
  });
});

const patches: {
  name: string;
  draft: Parameters<typeof workspaceSettingsPatch>[1];
  committedTheme?: "slate" | "whiteboard" | "triplicate" | "stockroom";
  patch: ReturnType<typeof workspaceSettingsPatch>;
}[] = [
  { name: "an empty draft", draft: {}, patch: null },
  {
    name: "a draft equal to the saved values",
    draft: {
      name: " Riverside Services ",
      locale: "English (Philippines)",
      timezone: "Asia/Manila",
      logo: "RS ",
      currency: "PHP",
      week: "Monday",
      hours: " 09:00–18:00 ",
      theme: "slate",
      legalName: " ",
      description: "Field services",
      contactEmail: "office@example.com",
      contactPhone: "",
      postalAddress: "",
    },
    patch: null,
  },
  {
    name: "a trimmed name",
    draft: { name: "  Harbor operations  " },
    patch: { revision: 4, display_name: "Harbor operations" },
  },
  {
    name: "a regional format name",
    draft: { locale: "English (Singapore)" },
    patch: { revision: 4, locale: "en-SG" },
  },
  {
    name: "a saved locale tag outside the list",
    draft: { locale: "fr-CA" },
    patch: { revision: 4, locale: "fr-CA" },
  },
  {
    name: "a timezone",
    draft: { timezone: "UTC" },
    patch: { revision: 4, timezone: "UTC" },
  },
  {
    name: "a trimmed mark",
    draft: { logo: " HOP " },
    patch: { revision: 4, mark: "HOP" },
  },
  {
    name: "a cleared mark",
    draft: { logo: "" },
    patch: { revision: 4, mark: "" },
  },
  {
    name: "a currency",
    draft: { currency: "USD" },
    patch: { revision: 4, currency: "USD" },
  },
  {
    name: "a Sunday week start",
    draft: { week: "Sunday" },
    patch: { revision: 4, week_start: "sunday" },
  },
  {
    name: "trimmed business hours",
    draft: { hours: " 10:00–19:00 " },
    patch: { revision: 4, business_hours: "10:00–19:00" },
  },
  {
    name: "a theme other than the committed one",
    draft: { theme: "stockroom" },
    patch: { revision: 4, theme: "stockroom" },
  },
  {
    name: "the committed theme while the saved one differs",
    draft: { theme: "whiteboard" },
    committedTheme: "whiteboard",
    patch: null,
  },
  {
    name: "a trimmed legal name",
    draft: { legalName: "  Riverside Services Ltd  " },
    patch: { revision: 4, legal_name: "Riverside Services Ltd" },
  },
  {
    name: "a cleared description",
    draft: { description: "  " },
    patch: { revision: 4, description: null },
  },
  {
    name: "a contact phone",
    draft: { contactPhone: "+63 2 8123 4567" },
    patch: { revision: 4, contact_phone: "+63 2 8123 4567" },
  },
];

for (const row of patches)
  test(`the organization patch for ${row.name}`, () => {
    expect(
      workspaceSettingsPatch(
        fullProfile,
        row.draft,
        row.committedTheme ?? "slate",
      ),
    ).toEqual(row.patch);
  });

const regionalFormats: { label: string; tag: string }[] = [
  { label: "English (Australia)", tag: "en-AU" },
  { label: "English (Canada)", tag: "en-CA" },
  { label: "English (Europe)", tag: "en-150" },
  { label: "English (India)", tag: "en-IN" },
  { label: "English (Ireland)", tag: "en-IE" },
  { label: "English (New Zealand)", tag: "en-NZ" },
  { label: "English (Philippines)", tag: "en-PH" },
  { label: "English (Singapore)", tag: "en-SG" },
  { label: "English (South Africa)", tag: "en-ZA" },
  { label: "English (UK)", tag: "en-GB" },
  { label: "English (US)", tag: "en-US" },
];

for (const row of regionalFormats)
  test(`regional format ${row.label} saves ${row.tag} and reads back`, () => {
    expect(organizationLocaleTag(row.label)).toBe(row.tag);
    expect(organizationLocaleLabel(row.tag)).toBe(row.label);
  });

// A saved tag outside the list reads as its language name; the http journey
// "Manage organization shows readable locale names and sends locale tags"
// used fr-FR, and "regional choices retain saved aliases ..." keeps fr-CA.
const savedTags: { tag: string; label: string }[] = [
  { tag: "fr-FR", label: "French (France)" },
  { tag: "fr-CA", label: "Canadian French" },
  { tag: "not a tag", label: "not a tag" },
];

for (const row of savedTags)
  test(`saved locale ${row.tag} reads "${row.label}"`, () => {
    expect(organizationLocaleLabel(row.tag)).toBe(row.label);
  });

test("a value that is not a regional format name is sent unchanged", () => {
  expect(organizationLocaleTag("fr-CA")).toBe("fr-CA");
});

test("the currency list leaves out fund, metal and testing codes", () => {
  const codes = activeCurrencies.map((currency) => currency.code);
  for (const excluded of ["XTS", "XAU", "USN"])
    expect(codes).not.toContain(excluded);
  for (const offered of ["USD", "JPY", "SGD", "PHP"])
    expect(codes).toContain(offered);
  expect(new Set(codes).size).toBe(codes.length);
});

const revisionErrors: { name: string; error: unknown; stale: boolean }[] = [
  {
    name: "a 409 stale_revision",
    error: new ApiError(409, "stale", { code: "stale_revision" }),
    stale: true,
  },
  {
    name: "a 409 with another code",
    error: new ApiError(409, "conflict", { code: "name_taken" }),
    stale: false,
  },
  {
    name: "a 403 with the stale_revision code",
    error: new ApiError(403, "Forbidden", { code: "stale_revision" }),
    stale: false,
  },
  {
    name: "a 409 with a text detail",
    error: new ApiError(409, "stale_revision", "stale_revision"),
    stale: false,
  },
  {
    name: "an error that is not an API error",
    error: new Error("stale_revision"),
    stale: false,
  },
];

for (const row of revisionErrors)
  test(`${row.name} is ${row.stale ? "" : "not "}a stale revision`, () => {
    expect(isStaleWorkspaceRevision(row.error)).toBe(row.stale);
  });
