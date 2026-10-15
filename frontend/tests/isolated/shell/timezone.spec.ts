import { expect, test } from "@playwright/test";

import { isIanaTimezone } from "../../../src/lib/date-time";

// A personal timezone must be an IANA zone name; an offset, an empty value
// or a padded value is refused. The http journey "Profile Regional rejects an
// invalid IANA timezone and restores explicit organization inheritance" keeps
// the "+08:00" refusal and its alert.

const zones: { value: string; valid: boolean }[] = [
  { value: "UTC", valid: true },
  { value: "Europe/London", valid: true },
  { value: "America/Argentina/Buenos_Aires", valid: true },
  { value: "Etc/GMT+8", valid: true },
  { value: "+08:00", valid: false },
  { value: "-05:00", valid: false },
  { value: "", valid: false },
  { value: " Europe/London", valid: false },
  { value: "Nonsense/Zone", valid: false },
];

for (const row of zones)
  test(`timezone ${JSON.stringify(row.value)} is ${row.valid ? "accepted" : "refused"}`, () => {
    expect(isIanaTimezone(row.value)).toBe(row.valid);
  });
