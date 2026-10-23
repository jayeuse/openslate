import { expect, test } from "@playwright/test";

import { blockedSectionNotice } from "../../../src/components/systems/access/helpers/blocked-section";

// A department manager only sees Groups. A link to another section lands
// there, and one line names the section the link asked for.

test("a manager's link to another Access section names that section once it lands on Groups", () => {
  for (const [search, expected] of [
    ["view=overview", "Overview is not available to your account."],
    ["view=people", "People is not available to your account."],
    [
      "view=people&user=00000000-0000-4000-8000-000000000101",
      "People is not available to your account.",
    ],
    // A person link without a view opens People for an administrator.
    [
      "user=00000000-0000-4000-8000-000000000101",
      "People is not available to your account.",
    ],
    ["view=security", "Security is not available to your account."],
    // Groups itself, no section, and an unknown view ask for nothing blocked.
    ["view=groups", null],
    ["view=groups&group=00000000-0000-4000-8000-0000000000c1", null],
    ["", null],
    ["view=reports", null],
  ] as const)
    expect(
      blockedSectionNotice(new URLSearchParams(search)),
      search || "(none)",
    ).toBe(expected);
});
