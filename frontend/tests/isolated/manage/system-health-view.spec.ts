import { expect, test } from "@playwright/test";
import { createElement } from "react";

import {
  statusFailure,
  SystemHealthView,
  type OrganizationBlock,
  type SystemHealthState,
} from "../../../src/components/systems/manage/components/system-health";
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
  };
}

function view(
  state: SystemHealthState,
  options: {
    busy?: boolean;
    releaseLink?: boolean;
    viewer?: ReferenceViewer;
    organization?: OrganizationBlock | null;
  } = {},
): string {
  return staticMarkup(SystemHealthView, {
    state,
    busy: options.busy ?? false,
    onCheckAgain: () => {},
    announcement: "",
    viewer: options.viewer ?? "member",
    organization: options.organization ?? null,
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

test("each status is a word beside an icon whose shape differs", () => {
  const markup = view({ ...result, status: status("set_up") });
  // Working, Not working and Set up rows; the headline's icon is CircleX.
  expect(markup.match(/lucide-circle-check/g)).toHaveLength(2);
  expect(markup.match(/lucide-circle-x/g)).toHaveLength(2);
  expect(markup).toContain("lucide-circle-dashed");
  expect(words(markup)).toContain("</svg>Not working</span>");
  expect(words(markup)).toContain("</svg>Set up</span>");
  expect(words(markup)).toContain(
    ">Slate Operations cannot yet confirm delivery.</span>",
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
    // Finding 4: each part is its own unbreakable span; the line wraps
    // only between parts.
    ">Last good backup on Oct 30 at 2:00 AM</span> · <span>Latest run: Failed</span>",
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
  // Four parts, the version and the three organization values show a dash.
  expect(markup.match(/>—</g)).toHaveLength(8);
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
