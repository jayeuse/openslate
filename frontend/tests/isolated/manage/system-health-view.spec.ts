import { expect, test } from "@playwright/test";
import { createElement, type ReactNode } from "react";

import {
  statusFailure,
  SystemHealthView,
  type InstallationBlock,
  type OrganizationBlock,
  type SystemHealthState,
} from "../../../src/components/systems/manage/components/system-health";
import { SupportFileView } from "../../../src/components/systems/manage/components/system-health-support-file";
import {
  TimelineView,
  type TimelineState,
} from "../../../src/components/systems/manage/components/system-health-timeline";
import type { PeriodRow } from "../../../src/components/systems/manage/domain/health-rules";
import type { ReferenceViewer } from "../../../src/lib/reference-viewer";
import type { SystemStatus } from "../../../src/components/systems/manage/adapters/system-status-api";
import { staticMarkup } from "../sandbox/static-markup";

// What Manage → System health shows (docs/specs/system-health.md): the blocks
// in reading order, frame first with no curtain (S2-C6, D2.1 to D2.7), and
// status words as text beside icons that differ by shape (S2-C9, D2.3).

const reference = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";

function status(email: SystemStatus["parts"][number]["status"]): SystemStatus {
  return {
    parts: [
      { key: "data", status: "working" },
      { key: "signing_in", status: "working" },
      { key: "files", status: "not_working" },
      { key: "email", status: email },
    ],
    version: "0.1.0",
    checked_at: "2026-11-02T10:42:05Z",
    organization: null,
    installation: null,
  };
}

function view(
  state: SystemHealthState,
  options: {
    busy?: boolean;
    releaseLink?: boolean;
    viewer?: ReferenceViewer;
    organization?: OrganizationBlock | null;
    installation?: InstallationBlock | null;
    timeline?: ReactNode;
    supportFile?: ReactNode;
  } = {},
): string {
  return staticMarkup(SystemHealthView, {
    state,
    busy: options.busy ?? false,
    onCheckAgain: () => {},
    announcement: "",
    viewer: options.viewer ?? "member",
    organization: options.organization ?? null,
    installation: options.installation ?? null,
    timeline: options.timeline ?? null,
    supportFile: options.supportFile ?? null,
    linkTo: (href: string, label: string) =>
      createElement("a", { href }, label),
    releaseLink: options.releaseLink
      ? createElement(
          "a",
          { href: "https://example.test/notes" },
          "Release notes",
        )
      : null,
  });
}

const words = (markup: string) => markup.replace(/ class="[^"]*"/g, "");

function inOrder(markup: string, parts: string[]) {
  const positions = parts.map((part) => markup.indexOf(part));
  for (const [index, position] of positions.entries())
    expect(position, `"${parts[index]}" is shown`).toBeGreaterThan(-1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

const result: SystemHealthState = {
  kind: "result",
  status: status("set_up"),
  checkLine: "Checked at 10:42 AM",
  failure: null,
};

test("the page reads headline, parts, About and help, in that order", () => {
  const markup = words(view(result));
  inOrder(markup, [
    ">Files and pictures are not working. Everything else works.</h2>",
    ">Checked at 10:42 AM<",
    "Check again</button>",
    ">Parts of Slate Operations</h2>",
    ">Saving and loading your data</dt>",
    ">Signing in</dt>",
    ">Files and pictures</dt>",
    ">Email</dt>",
    ">About this system</h2>",
    ">Version</dt>",
    ">0.1.0<",
    ">When something goes wrong</h2>",
    "Give this reference to your administrator.",
    "If it still does not load, tell your administrator.",
  ]);
  // Four cards; the S3 organization block renders nothing yet.
  expect(markup.match(/<section /g)).toHaveLength(4);
  expect(markup).not.toContain("Your organization");
  expect(markup).not.toMatch(/Checking/);
});

/** Each pane's name and the block titles inside it, in DOM order. */
function panes(markup: string) {
  return markup
    .split('data-health-pane="')
    .slice(1)
    .map((pane) => ({
      name: pane.slice(0, pane.indexOf('"')),
      blocks: [...pane.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(
        (heading) => heading[1],
      ),
    }));
}

test("SP-C4: the panes follow what renders, with no empty pane and no tab stop", () => {
  const organization: OrganizationBlock = "pending";
  const installation: InstallationBlock = "pending";
  const parts = { name: "parts", blocks: ["Parts of Slate Operations"] };
  const help = {
    name: "help",
    blocks: ["About this system", "When something goes wrong"],
  };
  // Blocks 3 and 4 are null for a member, and while the identity loads (D24).
  expect(panes(words(view(result)))).toEqual([parts, help]);
  expect(panes(words(view(result, { organization })))).toEqual([
    parts,
    { name: "details", blocks: ["Your organization"] },
    help,
  ]);
  expect(panes(words(view(result, { organization, installation })))).toEqual([
    parts,
    { name: "details", blocks: ["Your organization", "Installation"] },
    help,
  ]);
  // An installation owner who is not an admin.
  expect(panes(words(view(result, { installation })))).toEqual([
    parts,
    { name: "details", blocks: ["Installation"] },
    help,
  ]);
  const opening = view(result, { organization, installation }).match(
    /<div[^>]*data-health-pane[^>]*>/g,
  );
  expect(opening).toHaveLength(3);
  expect(opening?.join("")).not.toContain("tabindex");
});

test("each status is a word beside an icon whose shape differs", () => {
  const markup = view({ ...result, status: status("set_up") });
  // Working, Not working and Set up rows; the headline's icon is CircleX.
  expect(markup.match(/lucide-circle-check/g)).toHaveLength(2);
  expect(markup.match(/lucide-circle-x/g)).toHaveLength(2);
  expect(markup).toContain("lucide-circle-dashed");
  expect(words(markup)).toContain("</svg>Not working</span>");
  expect(words(markup)).toContain("</svg>Set up</span>");
  expect(words(markup)).toContain(
    ">No email was sent recently, so Slate Operations cannot confirm that it works.</span>",
  );
  const notSetUp = view({ ...result, status: status("not_set_up") });
  expect(notSetUp).toContain("lucide-circle-minus");
  expect(words(notSetUp)).toContain("</svg>Not set up</span>");
});

test("a running check keeps the page and marks only Check again as busy", () => {
  const markup = words(view(result, { busy: true }));
  const button = markup.match(
    /<button[^>]*>(?:(?!<\/button>).)*Check again<\/button>/,
  )?.[0];
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain('aria-disabled="true"');
  expect(markup).toContain(">Files and pictures are not working.");
  expect(markup).not.toMatch(/Checking|disabled=""/);
});

test("a failed check after a good one keeps the last result and says so", () => {
  const markup = words(
    view({
      ...result,
      failure: {
        message:
          "The status could not be checked. The result below is from the last check.",
        reference,
      },
    }),
  );
  inOrder(markup, [
    ">Files and pictures are not working. Everything else works.</h2>",
    ">Checked at 10:42 AM<",
    "Check again</button>",
    '<div role="alert" data-slot="alert" data-variant="destructive">',
    ">The status could not be checked. The result below is from the last check.<",
    '<code title="019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c">2e1a0b2c</code>',
  ]);
  expect(markup).toContain("</svg>Not working</span>");
});

test("a status that cannot be checked yet says so and invents no part status", () => {
  const markup = words(
    view({
      kind: "unavailable",
      failure: {
        message: "The status could not be loaded. Try Check again in a minute.",
        reference,
      },
    }),
  );
  expect(markup).toContain(">The status cannot be checked now.</h2>");
  expect(markup).toContain(
    ">The status could not be loaded. Try Check again in a minute.<",
  );
  expect(markup).toContain(">2e1a0b2c</code>");
  expect(markup).not.toMatch(/Checked at|Not working|Working|lucide-circle/);
  // The four cells and the version show a dash.
  expect(markup.match(/>—</g)).toHaveLength(5);
});

test("a failure with no response shows the connection message and no reference", () => {
  const markup = words(
    view({
      kind: "unavailable",
      failure: {
        message: "Could not connect. Check your connection and try again.",
        reference: undefined,
      },
    }),
  );
  expect(markup).toContain(
    ">Could not connect. Check your connection and try again.<",
  );
  const alert = markup.match(/<div role="alert"(?:(?!<\/div>).)*<\/div>/)?.[0];
  expect(alert).toBe(
    '<div role="alert" data-slot="alert" data-variant="destructive"><p>Could not connect. Check your connection and try again.</p></div>',
  );
  expect(markup).not.toContain('aria-label="Copy reference"');
});

test("only the installation owner's page links the release notes", () => {
  expect(words(view(result, { releaseLink: true }))).toContain(
    '>0.1.0</span><span aria-hidden="true">·</span><a href="https://example.test/notes">Release notes</a>',
  );
  expect(words(view(result))).not.toContain("Release notes");
});

test("a failed connection after a good result says the result is from the last check", () => {
  // D2.7: the connection message, and no reference (S1-C5).
  expect(statusFailure(new TypeError("Failed to fetch"), true)).toEqual({
    message:
      "Could not connect. Check your connection and try again. The result below is from the last check.",
    reference: undefined,
  });
  expect(statusFailure(new TypeError("Failed to fetch"), false)).toEqual({
    message: "Could not connect. Check your connection and try again.",
    reference: undefined,
  });
});

// Block 3, Your organization (S3-C5, D8), and block 6 by viewer (D6-C1).

const lateBlock: OrganizationBlock = {
  backups: {
    state: "late",
    word: "Late",
    detail: ["Last good backup on Oct 30 at 2:00 AM", "Latest run: Failed"],
    followUp: "owner-manages",
  },
  failedJobs: "2 jobs failed in the last 7 days",
  signIns: "1 failed sign-in and 2 lockouts in the last 7 days",
  storage: "Files use 1.2 GB",
};

test("S3-C5: an admin reads Your organization between the parts and About", () => {
  const markup = words(
    view(result, { viewer: "admin", organization: lateBlock }),
  );
  inOrder(markup, [
    ">Parts of Slate Operations</h2>",
    ">Your organization</h2>",
    ">Backups</dt>",
    "</svg>Late</span>",
    // Each part is its own span, and the separator its own (D35.7): from
    // 1280px a part takes its own line and the separator hides.
    ">Last good backup on Oct 30 at 2:00 AM</span><span> · </span><span>Latest run: Failed</span>",
    ">The person who runs your server manages backups.<",
    ">Failed jobs</dt>",
    ">2 jobs failed in the last 7 days<",
    '<a href="/manage?view=jobs">Open Jobs</a>',
    ">Sign-in activity</dt>",
    ">1 failed sign-in and 2 lockouts in the last 7 days<",
    '<a href="/access?view=security">Open Security in Access</a>',
    ">About this system</h2>",
  ]);
  expect(markup.match(/<section /g)).toHaveLength(5);
  // Late has its own shape; a count is not a status, so it has no icon.
  const block = view(result, { viewer: "admin", organization: lateBlock });
  expect(block).toContain("lucide-circle-alert");
  expect(markup).not.toContain("Open Backup");
});

test("S3-C5: the installation owner's late backup links Backup, and on time has no third line", () => {
  const owner = words(
    view(result, {
      viewer: "owner",
      organization: {
        ...lateBlock,
        backups: { ...lateBlock.backups, followUp: "open-backup" },
      },
    }),
  );
  inOrder(owner, [
    "</svg>Late</span>",
    '<a href="/manage?view=backup">Open Backup</a>',
    '<a href="/manage?view=jobs">Open Jobs</a>',
  ]);
  expect(owner).not.toContain("manages backups");
  const onTime = words(
    view(result, {
      viewer: "owner",
      organization: {
        ...lateBlock,
        backups: {
          state: "on_time",
          word: "On time",
          detail: ["Last good backup today at 2:00 AM", "Latest run: Verified"],
          followUp: null,
        },
      },
    }),
  );
  expect(onTime).toContain("</svg>On time</span>");
  expect(onTime).not.toMatch(/Open Backup|manages backups/);
});

test("S3-C5: members see no organization block, and a result without the part hides it", () => {
  // The page passes null whenever the response has no organization part.
  for (const viewer of ["member", "admin"] as const) {
    const markup = words(view(result, { viewer, organization: null }));
    expect(markup).not.toContain("Your organization");
    expect(markup.match(/<section /g)).toHaveLength(4);
  }
});

test("S3-C5: before any result the block keeps its labels, shows dashes and keeps the links", () => {
  const markup = words(
    view(
      {
        kind: "unavailable",
        failure: {
          message:
            "The status could not be loaded. Try Check again in a minute.",
          reference,
        },
      },
      { viewer: "admin", organization: "pending" },
    ),
  );
  const block = markup.slice(
    markup.indexOf(">Your organization</h2>"),
    markup.indexOf(">About this system</h2>"),
  );
  inOrder(block, [
    ">Backups</dt><dd><span>—</span></dd>",
    '>Failed jobs</dt><dd><span>—</span><a href="/manage?view=jobs">Open Jobs</a></dd>',
    '>Sign-in activity</dt><dd><span>—</span><a href="/access?view=security">Open Security in Access</a></dd>',
  ]);
  // Only block 1 shows the failure: one alert on the page.
  expect(markup.match(/role="alert"/g)).toHaveLength(1);
  // Four parts, the version and the four organization values show a dash.
  expect(markup.match(/>—</g)).toHaveLength(9);
});

test("D6-C1: block 6 names whom to tell, by viewer", () => {
  const member = words(view(result));
  expect(member).toContain(
    "with a Copy button. Give this reference to your administrator.</p>",
  );
  expect(member).toContain(
    "<p>When Slate Operations does not load: wait a minute and reload. If it still does not load, tell your administrator.</p>",
  );
  const admin = words(view(result, { viewer: "admin" }));
  expect(admin).toContain(
    "with a Copy button. Give this reference to the person who runs your server.</p>",
  );
  expect(admin).toContain(
    "<p>When Slate Operations does not load: wait a minute and reload. If it still does not load, tell the person who runs your server.</p>",
  );
  const owner = words(view(result, { viewer: "owner" }));
  expect(owner).toContain("with a Copy button.</p>");
  expect(owner).toContain(
    "<p>When Slate Operations does not load: wait a minute and reload. If it still does not load, check that your server is running.</p>",
  );
  expect(owner).not.toMatch(/Give this reference|your administrator/);
});

test("S3-C5, D13 item 1: a backup state that cannot be read shows its own word and Late's third line", () => {
  const raw = view(result, {
    viewer: "admin",
    organization: {
      backups: {
        state: "unknown",
        word: "Cannot be checked",
        detail: ["Slate Operations cannot read the backup state now."],
        followUp: "owner-manages",
      },
      failedJobs: "The failed job count cannot be read now.",
      signIns: "No failed sign-ins or lockouts in the last 7 days",
      storage: "File storage cannot be read now.",
    },
  });
  const block = raw.slice(raw.indexOf("Your organization"));
  // CircleDashed already means "cannot confirm" in block 2.
  expect(block).toContain("lucide-circle-dashed");
  inOrder(words(block), [
    "</svg>Cannot be checked</span>",
    ">Slate Operations cannot read the backup state now.</span>",
    ">The person who runs your server manages backups.<",
    ">The failed job count cannot be read now.<",
    '<a href="/manage?view=jobs">Open Jobs</a>',
  ]);
});

// S5 and S6 (D14 to D19): Slow, file storage, the installation block, the
// 30-day timeline and the support file.

test("S5-C4: a Slow part reads Slow beside a gauge, with its cause line", () => {
  const slow: SystemStatus = {
    ...status("working"),
    parts: [
      { key: "data", status: "working" },
      { key: "signing_in", status: "slow" },
      { key: "files", status: "working" },
      { key: "email", status: "working" },
    ],
  };
  const raw = view({ ...result, status: slow });
  const markup = words(raw);
  inOrder(markup, [
    ">Signing in is slow. Everything else works.</h2>",
    ">Signing in</dt>",
    "</svg>Slow</span>",
    ">Signing in may take longer than usual.</span>",
  ]);
  // The headline and the row: the gauge shape is Slow's alone.
  expect(raw.match(/lucide-circle-gauge/g)).toHaveLength(2);
  expect(raw).not.toContain("lucide-circle-x");
});

test("S5-C7: an admin reads File storage after Sign-in activity, with the limit line", () => {
  const markup = words(
    view(result, { viewer: "admin", organization: lateBlock }),
  );
  inOrder(markup, [
    ">Sign-in activity</dt>",
    "Open Security in Access</a>",
    ">File storage</dt>",
    ">Files use 1.2 GB<",
    ">Storage limit: not set yet<",
    ">About this system</h2>",
  ]);
  const block = markup.slice(
    markup.indexOf(">File storage</dt>"),
    markup.indexOf(">About this system</h2>"),
  );
  // A size is not a status: no icon and no link.
  expect(block).not.toMatch(/<svg|<a /);
});

const ownerInstallation: InstallationBlock = {
  database: "1.4 GB",
  workers: [
    {
      key: "record_triggers",
      label: "Record triggers",
      state: "running",
      word: "Running",
      detail: null,
    },
    {
      key: "report_scheduling",
      label: "Scheduled reports",
      state: "not_seen",
      word: "Not seen since 10:42 AM",
      detail: "Its work waits until it runs again.",
    },
    {
      key: "comms_jobs",
      label: "OpenComms jobs",
      state: "never_seen",
      word: "Not seen yet",
      detail: "Check that it runs on your server.",
    },
    {
      key: "provider_signout",
      label: "Sign-out cleanup",
      state: "running",
      word: "Running",
      detail: null,
    },
    {
      key: "backup_runner",
      label: "Backup runner",
      state: "running",
      word: "Running",
      detail: null,
    },
  ],
};

test("S5-C6: the installation owner reads Installation between Your organization and About", () => {
  const raw = view(result, {
    viewer: "owner",
    organization: lateBlock,
    installation: ownerInstallation,
  });
  const markup = words(raw);
  inOrder(markup, [
    ">Your organization</h2>",
    ">Installation</h2>",
    ">Database size</dt>",
    ">1.4 GB<",
    ">Record triggers</dt>",
    "</svg>Running</span>",
    ">Scheduled reports</dt>",
    "</svg>Not seen since 10:42 AM</span>",
    ">Its work waits until it runs again.<",
    ">OpenComms jobs</dt>",
    "</svg>Not seen yet</span>",
    ">Check that it runs on your server.<",
    ">Sign-out cleanup</dt>",
    ">Backup runner</dt>",
    ">About this system</h2>",
  ]);
  expect(markup.match(/<section /g)).toHaveLength(6);
  const block = raw.slice(
    raw.indexOf(">Installation</h2>"),
    raw.indexOf(">About this system</h2>"),
  );
  // Running, not seen and never seen differ by shape.
  expect(block.match(/lucide-circle-check/g)).toHaveLength(3);
  expect(block.match(/lucide-circle-x/g)).toHaveLength(1);
  expect(block.match(/lucide-circle-dashed/g)).toHaveLength(1);
  // Nobody else gets the card.
  for (const viewer of ["member", "admin"] as const)
    expect(words(view(result, { viewer }))).not.toContain(">Installation</h2>");
});

test("S5-C6: before any result the owner's block keeps its six labels and shows dashes", () => {
  const markup = words(
    view(
      {
        kind: "unavailable",
        failure: { message: "The status could not be loaded.", reference },
      },
      { viewer: "owner", installation: "pending" },
    ),
  );
  const block = markup.slice(
    markup.indexOf(">Installation</h2>"),
    markup.indexOf(">About this system</h2>"),
  );
  expect(block.match(/<dt>/g)).toHaveLength(6);
  expect(block.match(/>—</g)).toHaveLength(6);
  expect(markup.match(/role="alert"/g)).toHaveLength(1);
});

test("S5-C3: the timeline sits in block 2 under the parts; S6: the support file in block 6", () => {
  const markup = words(
    view(result, {
      timeline: createElement("p", null, "TIMELINE"),
      supportFile: createElement("p", null, "SUPPORT FILE"),
    }),
  );
  inOrder(markup, [
    ">Parts of Slate Operations</h2>",
    ">Email</dt>",
    ">TIMELINE<",
    ">About this system</h2>",
    ">When something goes wrong</h2>",
    "If it still does not load, tell your administrator.",
    ">SUPPORT FILE<",
  ]);
  // Both live inside existing cards: no new card for a member.
  expect(markup.match(/<section /g)).toHaveLength(4);
});

const ongoingRow: PeriodRow = {
  key: "email:not_working:2026-11-02T14:42:00Z",
  kind: "not_working",
  sentence: "Email has not worked since 9:42 AM today.",
  meta: null,
};
const endedRow: PeriodRow = {
  key: "files:slow:2026-11-01T03:50:00Z",
  kind: "slow",
  sentence: "Files and pictures were slow for 1 hour 20 minutes yesterday.",
  meta: { from: "Oct 31 at 11:50 PM", to: "Nov 1 at 1:10 AM" },
};

function timeline(state: TimelineState, focusKey: string | null = null) {
  return staticMarkup(TimelineView, {
    state,
    focusKey,
    onRetry: () => {},
    onShowOlder: () => {},
  });
}

test("S5-C3: the timeline lists each period as a sentence with its times, under its heading", () => {
  const raw = timeline({
    kind: "rows",
    rows: [ongoingRow, endedRow],
    empty: "No problems in the last 30 days.",
    older: "idle",
  });
  const markup = words(raw);
  inOrder(markup, [
    '<h3 id="system-health-timeline">Last 30 days</h3>',
    '<ol aria-labelledby="system-health-timeline">',
    ">Email has not worked since 9:42 AM today.<",
    ">Still going<",
    ">Files and pictures were slow for 1 hour 20 minutes yesterday.<",
    // The meta line wraps only around "to"; each time stays whole.
    "<span>Oct 31 at 11:50 PM</span> to <span>Nov 1 at 1:10 AM</span>",
    "Show older</button>",
  ]);
  expect(raw.indexOf("lucide-circle-x")).toBeLessThan(
    raw.indexOf("lucide-circle-gauge"),
  );
  expect(markup).not.toContain("No problems");
});

test("S5-C3: with no period the timeline shows its sentence and no Show older", () => {
  const markup = words(
    timeline({
      kind: "rows",
      rows: [],
      empty: "No problems in the last 30 days.",
      older: "none",
    }),
  );
  expect(markup).toContain(">No problems in the last 30 days.<");
  expect(markup).not.toMatch(/<ol|Show older/);
});

test("S5-C3: older periods load busy, and a failure keeps the rows with Retry and a reference", () => {
  const busy = words(
    timeline({
      kind: "rows",
      rows: [ongoingRow],
      empty: "",
      older: "loading",
    }),
  );
  const button = busy.match(/<button[^>]*>Show older<\/button>/)?.[0];
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain('aria-disabled="true"');
  const failed = words(
    timeline({
      kind: "rows",
      rows: [ongoingRow],
      empty: "",
      older: { failed: reference },
    }),
  );
  inOrder(failed, [
    ">Email has not worked since 9:42 AM today.<",
    ">Older periods could not be loaded.<",
    "Retry</button>",
    ">2e1a0b2c</code>",
  ]);
  expect(failed).not.toContain("Show older");
});

test("S5-C3: the timeline's own read shows loading and a failure with Retry and a reference", () => {
  expect(words(timeline({ kind: "loading" }))).toContain("Last 30 days</h3>");
  const failed = words(timeline({ kind: "error", reference }));
  inOrder(failed, [
    ">Last 30 days</h3>",
    ">The last 30 days could not be loaded.<",
    "Retry</button>",
    ">2e1a0b2c</code>",
  ]);
});

function supportFile(
  viewer: ReferenceViewer,
  state: Partial<{
    busy: boolean;
    announcement: string;
    failure: { message: string; reference: string | undefined } | null;
  }> = {},
) {
  return staticMarkup(SupportFileView, {
    viewer,
    busy: state.busy ?? false,
    announcement: state.announcement ?? "",
    failure: state.failure ?? null,
    onDownload: () => {},
  });
}

test("S6-C2, S6-C3, S6-C4: each role reads its own support file words; members see none", () => {
  const admin = words(supportFile("admin"));
  inOrder(admin, [
    // The markup escapes the apostrophe.
    "<p>A support file helps the person who runs your server find a problem. It lists the versions, the last 30 days of the parts, your organization&#x27;s file storage, and its recent server errors with their references. It holds no records, no personal data and nothing from other organizations.</p>",
    "Download support file</button>",
    '<span role="status"></span>',
  ]);
  const owner = words(supportFile("owner"));
  expect(owner).toContain(
    "<p>A support file helps whoever supports your installation find a problem. It lists the versions, the database size, the background workers, each organization&#x27;s file storage, 30 days of checks, and recent server errors with their references. It holds no records and no personal data.</p>",
  );
  expect(supportFile("member")).toBe("");
});

test("D19.4: a running download marks the button busy and speaks through its status span", () => {
  const busy = words(
    supportFile("admin", {
      busy: true,
      announcement: "Preparing the support file…",
    }),
  );
  const button = busy.match(
    /<button[^>]*>(?:(?!<\/button>).)*Download support file<\/button>/,
  )?.[0];
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain('aria-disabled="true"');
  expect(button).not.toContain('disabled=""');
  expect(busy).toContain(
    '<span role="status">Preparing the support file…</span>',
  );
});

test("D19.4: a failed download shows its message and reference under the button", () => {
  const failed = words(
    supportFile("admin", {
      failure: {
        message:
          "The support file could not be prepared. Try again in a minute.",
        reference,
      },
    }),
  );
  inOrder(failed, [
    "Download support file</button>",
    '<div role="alert" data-slot="alert" data-variant="destructive">',
    ">The support file could not be prepared. Try again in a minute.<",
    ">2e1a0b2c</code>",
  ]);
  // The status span says nothing while the Alert shows.
  expect(failed).toContain('<span role="status"></span>');
});
