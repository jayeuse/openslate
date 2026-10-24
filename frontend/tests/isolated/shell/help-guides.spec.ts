import { expect, test } from "@playwright/test";

import { pageGuideForNavigation } from "../../../src/components/help/page-guides";
import { currentNavigationKey } from "../../../src/components/workspace-navigation";

// Each canonical page opens a This-page guide of three to six entries that
// name its real tasks; a page without a guide shows none. The routes and task
// words came from the http loop "Help canonical guide ${href} has three to six
// honest task entries", which keeps /access to prove the guide renders.

const guides: { href: string; title: string; tasks: RegExp[] }[] = [
  {
    href: "/sandbox",
    title: "Sandbox",
    tasks: [
      /department/i,
      /build|design/i,
      /Summary/,
      /Save triggers/,
      /current setup/,
      /checkpoint first/,
    ],
  },
  { href: "/boards", title: "Boards", tasks: [/post/i, /calendar|event/i] },
  {
    href: "/comms",
    title: "OpenComms",
    tasks: [
      /server/i,
      /Admin tools.*saved to your organization/i,
      /message|conversation/i,
    ],
  },
  { href: "/access", title: "Access", tasks: [/people/i, /group|access/i] },
  { href: "/openview", title: "OpenView", tasks: [/record/i, /view|report/i] },
  {
    href: "/manage",
    title: "Manage",
    // Phase 7 (MG14): one entry per section, in the words each one shows.
    tasks: [
      /organization/i,
      /Save settings/,
      /quick filters.*Filters.*event details/,
      /Status.*History.*details/,
      /state filters.*Pending, Queued.*Retry/,
      /Installation panel/,
    ],
  },
  { href: "/platform", title: "Platform", tasks: [/search/i, /file/i] },
  {
    href: "/profile",
    title: "Profile",
    tasks: [/identity|profile/i, /preference|look|sign.in/i],
  },
];

for (const row of guides)
  test(`the ${row.href} guide has three to six entries that name its tasks`, () => {
    const guide = pageGuideForNavigation(
      currentNavigationKey(row.href, new URLSearchParams()),
    );
    expect(guide?.title).toBe(row.title);
    const entries = guide?.entries.filter((entry) => entry !== undefined) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.length).toBeLessThanOrEqual(6);
    for (const task of row.tasks) expect(entries.join(" ")).toMatch(task);
  });

const missing: { name: string; key: string | null }[] = [
  { name: "no page", key: null },
  { name: "an unknown page", key: "settings:general" },
  { name: "an inherited object key", key: "constructor" },
];

for (const row of missing)
  test(`${row.name} has no guide`, () => {
    expect(pageGuideForNavigation(row.key)).toBeNull();
  });
