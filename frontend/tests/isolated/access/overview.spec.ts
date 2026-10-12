import { expect, test } from "@playwright/test";

import {
  invitationSettingsErrors,
  invitationSettingsPatch,
} from "../../../src/components/systems/access/helpers/overview";
import { directoryFiltersFromParams } from "../../../src/components/systems/access/helpers/people";

test("filters from the URL fall back to the defaults for unknown values", () => {
  expect(
    directoryFiltersFromParams(new URLSearchParams("role=owner&status=gone")),
  ).toMatchObject({ role: "all", status: "current", groupId: "all" });
});

test("invitation settings accept whole days from 1 to 365", () => {
  expect(
    invitationSettingsErrors({
      invitationExpiryDays: "7",
      guestDurationDays: "365",
    }),
  ).toEqual({});
  expect(
    invitationSettingsErrors({
      invitationExpiryDays: "0",
      guestDurationDays: "",
    }),
  ).toEqual({
    invitationExpiryDays: "Enter a whole number from 1 to 365.",
    guestDurationDays: "Enter the number of days.",
  });
  expect(
    invitationSettingsErrors({
      invitationExpiryDays: "2.5",
      guestDurationDays: "366",
    }),
  ).toEqual({
    invitationExpiryDays: "Enter a whole number from 1 to 365.",
    guestDurationDays: "Enter a whole number from 1 to 365.",
  });
});

test("the settings patch sends only changed values with the revision", () => {
  const saved = {
    invitation_expiry_days: 7,
    guest_duration_days: 30,
    revision: 4,
  };
  expect(
    invitationSettingsPatch(saved, {
      invitationExpiryDays: "7",
      guestDurationDays: "45",
    }),
  ).toEqual({ revision: 4, guest_duration_days: 45 });
  expect(
    invitationSettingsPatch(saved, {
      invitationExpiryDays: "7",
      guestDurationDays: "30",
    }),
  ).toBeNull();
});
