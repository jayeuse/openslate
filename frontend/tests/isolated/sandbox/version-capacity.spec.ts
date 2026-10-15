import { expect, test } from "@playwright/test";
import {
  VersionCapacityBanner,
  type VersionCapacityActions,
} from "../../../src/components/systems/sandbox/components/version-capacity-banner";
import { staticMarkup } from "./static-markup";

// The banner is shared by History and the Save checkpoint dialog. The http
// journey "capacity 45 is global in filtered History and checkpoint dialog"
// proves both places use the global count; this table owns which count shows
// what.

function banner(state: VersionCapacityActions["state"]): string {
  return staticMarkup(VersionCapacityBanner, {
    state,
    pending: false,
    onRetry: async () => {},
    onPrune: async () => ({ ok: true, value: 0 }),
  });
}

const warning = (count: number) =>
  `${count} of 50 versions used. Delete the oldest unpublished checkpoints to free space.`;

for (const row of [
  {
    name: "loading capacity says it is checking and offers no delete",
    state: { status: "loading" } as const,
    shown: ["Checking version capacity…"],
    hidden: ["versions used", "Delete old checkpoints", "Retry capacity"],
  },
  {
    name: "unavailable capacity asks for Retry and offers no delete",
    state: { status: "unavailable" } as const,
    shown: [
      "Version capacity is unavailable. Retry before deleting old checkpoints.",
      "Retry capacity",
    ],
    hidden: ["versions used", "Delete old checkpoints"],
  },
  {
    name: "44 of 50 versions shows no warning",
    state: { status: "ready", mutableCount: 44, versionCap: 50 } as const,
    shown: [],
    hidden: ["versions used", "Delete old checkpoints", "Retry capacity"],
  },
  {
    name: "45 of 50 versions warns and offers to delete old checkpoints",
    state: { status: "ready", mutableCount: 45, versionCap: 50 } as const,
    shown: [warning(45), "Delete old checkpoints"],
    hidden: ["Retry capacity"],
  },
  {
    name: "50 of 50 versions warns and offers to delete old checkpoints",
    state: { status: "ready", mutableCount: 50, versionCap: 50 } as const,
    shown: [warning(50), "Delete old checkpoints"],
    hidden: ["Retry capacity"],
  },
]) {
  test(`version capacity: ${row.name}`, () => {
    const html = banner(row.state);
    for (const text of row.shown) expect(html).toContain(text);
    for (const text of row.hidden) expect(html).not.toContain(text);
  });
}
